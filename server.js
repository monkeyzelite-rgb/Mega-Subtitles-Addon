require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const axios = require('axios');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const jschardet = require('jschardet');
const { clearSearchCache } = require('./lib/regielive');

const app = express();
app.use(cors());
app.use(express.static('public'));

function fixRomanianDiacritics(text) {
    return text
        .replace(/\u015F/g, '\u0219')
        .replace(/\u015E/g, '\u0218')
        .replace(/\u0163/g, '\u021B')
        .replace(/\u0162/g, '\u021A')
        .replace(/\u00E3/g, 'ă')
        .replace(/\u00E2/g, 'â')
        .replace(/\u00EE/g, 'î');
}

function srtToVtt(srtText) {
    let text = String(srtText).replace(/\r+/g, '').trim();
    text = text.replace(/^\d+\s*$/gm, '');
    text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return 'WEBVTT\n\n' + text.trim() + '\n';
}

const subtitlesCache = new Map();
const activeDownloads = new Map();
let globalDownloadQueue = Promise.resolve();

const RL_API_KEY = 'API-BAZARR-YTZ-SL';
const ADMIN_KEY = process.env.ADMIN_KEY || 'rosubs-admin-2026';
const TITRARI_COOKIE = process.env.TITRARI_COOKIE || '';

app.use(getRouter(addonInterface));

app.get('/admin/clear-cache', (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(403).send('Cheie invalida.');
    const downloadsCleared = subtitlesCache.size;
    subtitlesCache.clear();
    activeDownloads.clear();
    const searchesCleared = clearSearchCache();
    res.send(`Cache golit: ${downloadsCleared} subtitrari + ${searchesCleared} cautari.`);
});

function detectArchiveType(buffer) {
    if (buffer.length < 4) return 'unknown';
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) return 'zip';
    if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) return 'rar';
    return 'unknown';
}

// === SELECTIE INTELIGENTA DIN ARHIVA ===
// Cand arhiva contine mai multe subtitrari (ex. BluRay/, HDRip/, HD-TS/),
// alegem pe cea care se potriveste cu fisierul video redat, nu pe cea mai mare.

const DISC_KEYWORDS = ['remux', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'bd', 'uhd', 'hddvd'];
const WEB_KEYWORDS  = ['web-dl', 'webdl', 'webrip', 'web', 'amzn', 'nf', 'hmax', 'dsnp'];
const HDTV_KEYWORDS = ['hdtv', 'pdtv', 'tvrip'];
const LOW_KEYWORDS  = ['dvdrip', 'dvdscr', 'hdrip', 'cam', 'hdcam', 'hd-ts', 'hdts', 'telesync', 'telecine', 'r5'];

function getFileSourceType(text) {
    const t = (text || '').toLowerCase();
    if (LOW_KEYWORDS.some(s => t.includes(s)))  return 'low';
    if (DISC_KEYWORDS.some(s => t.includes(s))) return 'disc';
    if (HDTV_KEYWORDS.some(s => t.includes(s))) return 'hdtv';
    if (WEB_KEYWORDS.some(s => t.includes(s)))  return 'web';
    return null;
}

// Scoreaza un fisier din arhiva fata de filename-ul video
function scoreArchiveEntry(entryName, videoFilename) {
    if (!videoFilename) return 0;

    const entry = entryName.toLowerCase();
    const video = videoFilename.toLowerCase();
    let score = 0;

    // 1. Sursa (cel mai important) — BluRay video trebuie sa ia sub din folder BluRay
    const videoSrc = getFileSourceType(video);
    const entrySrc = getFileSourceType(entry);
    if (videoSrc && entrySrc) {
        if (videoSrc === entrySrc) {
            score += 100;
        } else if ((videoSrc === 'disc' && entrySrc === 'web') ||
                   (videoSrc === 'web'  && entrySrc === 'disc')) {
            score -= 80;
        } else {
            score -= 40;
        }
    }

    // 2. Rezolutie
    for (const res of ['2160p', '1080p', '720p', '480p']) {
        if (video.includes(res) && entry.includes(res)) { score += 40; break; }
    }

    // 3. Release group — ultimul token dupa cratima din filename video
    const groupMatch = video.match(/-([a-z0-9]{2,20})(?:\.[a-z0-9]{2,4})?$/i);
    if (groupMatch) {
        const group = groupMatch[1].toLowerCase();
        if (group.length >= 3 && entry.includes(group)) score += 80;
    }

    // 4. Codec
    for (const codec of ['x265', 'hevc', 'x264', 'h264', 'av1']) {
        if (video.includes(codec) && entry.includes(codec)) { score += 20; break; }
    }

    // 5. Sezon+Episod pentru seriale
    const seMatch = video.match(/s(\d{1,2})e(\d{1,2})/i);
    if (seMatch) {
        const se = `s${seMatch[1].padStart(2,'0')}e${seMatch[2].padStart(2,'0')}`;
        if (entry.includes(se)) score += 120;
    }

    return score;
}

// Alege cel mai potrivit fisier de subtitrare dintr-o lista
function pickBestSubtitleFile(candidates, videoFilename) {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const scored = candidates.map(c => ({
        entry: c,
        matchScore: scoreArchiveEntry(c.name, videoFilename),
        size: c.size || 0
    }));

    // Sortam: intai dupa potrivire, apoi dupa marime
    scored.sort((a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return b.size - a.size;
    });

    console.log(`[ARHIVA] ${candidates.length} fisiere, clasament:`);
    scored.slice(0, 5).forEach((s, i) => {
        const marker = i === 0 ? '  <-- ALES' : '';
        console.log(`   [${s.matchScore}] ${s.entry.name} (${s.size}b)${marker}`);
    });

    return scored[0].entry;
}

function extractFromZip(buffer, videoFilename) {
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    const candidates = zipEntries
        .filter(e => {
            const fn = e.entryName.toLowerCase();
            const base = fn.split('/').pop();
            return !fn.includes('__macosx') && !base.startsWith('.') &&
                   (fn.endsWith('.srt') || fn.endsWith('.sub'));
        })
        .map(e => ({ name: e.entryName, size: e.header.size || 0, _entry: e }));

    if (candidates.length === 0) {
        const txt = zipEntries.find(e => e.entryName.toLowerCase().endsWith('.txt'));
        if (txt) return txt.getData();
        throw new Error('NO_SRT_IN_ZIP');
    }

    const best = pickBestSubtitleFile(candidates, videoFilename);
    return best._entry.getData();
}

async function extractFromRar(buffer, videoFilename) {
    try {
        const { createExtractorFromData } = require('node-unrar-js');
        const extractor = await createExtractorFromData({ data: buffer });
        const list = extractor.getFileList();
        const fileHeaders = [...list.fileHeaders];

        const candidates = fileHeaders
            .filter(h => {
                const fn = h.name.toLowerCase();
                return fn.endsWith('.srt') || fn.endsWith('.sub');
            })
            .map(h => ({ name: h.name, size: h.unpSize || h.packSize || 0 }));

        if (candidates.length === 0) throw new Error('NO_SRT_IN_RAR');

        const best = pickBestSubtitleFile(candidates, videoFilename);
        console.log(`[RAR] Extrag: "${best.name}"`);

        const extracted = extractor.extract({ files: [best.name] });
        const files = [...extracted.files];
        if (files.length === 0) throw new Error('RAR_EXTRACT_FAILED');

        return Buffer.from(files[0].extraction);
    } catch (err) {
        console.error('[RAR] Eroare extractie:', err.message);
        throw new Error('RAR_EXTRACT_FAILED');
    }
}

app.get(['/download', '/download.vtt'], async (req, res) => {
    const zipUrl = req.query.url;
    const source = req.query.source || 'regielive';
    const sessionCookie = req.query.cookie || '';
    // Filename-ul video, trimis de addon.js ca sa alegem corect din arhiva
    const videoFilename = req.query.vf || '';

    if (!zipUrl) return res.status(400).send('URL lipsa');

    if (source === 'regielive' && zipUrl.includes('/descarca-') && zipUrl.endsWith('-0.zip')) {
        console.log(`[FILTRU] URL invalid RegieLive (id 0), refuz.`);
        return res.status(404).send('Subtitrare indisponibila.');
    }

    // Cheia de cache include si filename-ul — aceeasi arhiva poate da
    // subtitrari diferite pentru fisiere video diferite
    const cacheKey = `${zipUrl}::${videoFilename}`;

    const sendSubtitleResponse = (text, responseObj) => {
        const fixedText = fixRomanianDiacritics(text);
        const vttText = srtToVtt(fixedText);
        responseObj.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        responseObj.setHeader('Content-Disposition', 'inline; filename="subtitle.vtt"');
        responseObj.setHeader('Access-Control-Allow-Origin', '*');
        return responseObj.send(vttText);
    };

    if (subtitlesCache.has(cacheKey)) return sendSubtitleResponse(subtitlesCache.get(cacheKey), res);

    if (activeDownloads.has(cacheKey)) {
        try {
            return sendSubtitleResponse(await activeDownloads.get(cacheKey), res);
        } catch {
            return res.status(500).send('Eroare');
        }
    }

    const downloadTask = async () => {
        console.log(`\n[DESCARCARE][${source}] ${zipUrl}`);
        if (videoFilename) console.log(`[DESCARCARE] Pentru: ${videoFilename}`);

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/octet-stream, */*',
        };

        if (source === 'regielive') {
            headers['RL-API']  = RL_API_KEY;
            headers['Cookie']  = sessionCookie;
            headers['Referer'] = 'https://subtitrari.regielive.ro';
        } else if (source === 'titrari') {
            headers['Cookie']  = `PHPSESSID=${TITRARI_COOKIE}`;
            headers['Referer'] = 'https://www.titrari.ro';
            headers['Host']    = 'www.titrari.ro';
        } else if (source === 'subsro') {
            headers['X-Subs-Api-Key'] = process.env.SUBSRO_API_KEY || '';
        }

        const response = await axios({
            method: 'get',
            url: zipUrl,
            responseType: 'arraybuffer',
            headers,
            maxRedirects: 5
        });

        const buffer = Buffer.from(response.data);
        const archiveType = detectArchiveType(buffer);
        console.log(`[ARHIVA] Tip detectat: ${archiveType} (${buffer.length} bytes)`);

        let rawData;

        if (archiveType === 'zip') {
            rawData = extractFromZip(buffer, videoFilename);
        } else if (archiveType === 'rar') {
            rawData = await extractFromRar(buffer, videoFilename);
        } else {
            const preview = buffer.slice(0, 50).toString('utf8');
            if (preview.includes('-->') || /^\d+\s*\n/.test(preview)) {
                console.log(`[ARHIVA] SRT direct, il folosesc ca atare.`);
                rawData = buffer;
            } else {
                const bodyStr = buffer.toString('utf8');
                const titleMatch = bodyStr.match(/<title>([\s\S]*?)<\/title>/i);
                console.error(`[X][${source}] Format necunoscut!`);
                console.error(`    Content-Type: ${response.headers['content-type'] || ''}`);
                console.error(`    <title>: ${titleMatch ? titleMatch[1].trim() : '(fara title)'}`);
                console.error(`    Primele 200 chars: ${bodyStr.slice(0, 200)}`);
                throw new Error('UNKNOWN_FORMAT');
            }
        }

        const detected = jschardet.detect(rawData);
        let encoding = 'windows-1250';
        if (detected && detected.encoding) {
            const enc = detected.encoding.toLowerCase();
            if (enc.includes('utf') || enc === 'ascii') encoding = enc;
        }
        console.log(`[ENCODING] Detectat: ${detected?.encoding} → folosesc: ${encoding}`);

        return iconv.decode(rawData, encoding);
    };

    const queuedTask = new Promise((resolve, reject) => {
        globalDownloadQueue = globalDownloadQueue.then(async () => {
            try {
                await new Promise(r => setTimeout(r, 1500));
                resolve(await downloadTask());
            } catch (e) {
                reject(e);
            }
        }).catch(() => {});
    });

    activeDownloads.set(cacheKey, queuedTask);

    try {
        const subtitleText = await queuedTask;
        subtitlesCache.set(cacheKey, subtitleText);
        activeDownloads.delete(cacheKey);
        return sendSubtitleResponse(subtitleText, res);
    } catch (error) {
        activeDownloads.delete(cacheKey);
        if (error.response?.status === 429) {
            console.error(`[X][${source}] RATE LIMIT atins.`);
        }
        res.status(500).send('Eroare interna.');
    }
});

const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`RO Subs addon ruleaza la http://127.0.0.1:${port}/manifest.json`);
});
