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
        .replace(/\u015F/g, '\u0219') // ş → ș
        .replace(/\u015E/g, '\u0218') // Ş → Ș
        .replace(/\u0163/g, '\u021B') // ţ → ț
        .replace(/\u0162/g, '\u021A') // Ţ → Ț
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

function extractFromZip(buffer) {
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    const candidates = zipEntries.filter(e => {
        const fn = e.entryName.toLowerCase();
        const base = fn.split('/').pop();
        return !fn.includes('__macosx') && !base.startsWith('.') &&
               (fn.endsWith('.srt') || fn.endsWith('.sub'));
    });

    if (candidates.length === 0) {
        const txt = zipEntries.find(e => e.entryName.toLowerCase().endsWith('.txt'));
        if (txt) return txt.getData();
        throw new Error('NO_SRT_IN_ZIP');
    }

    candidates.sort((a, b) => (b.header.size || 0) - (a.header.size || 0));
    if (candidates.length > 1) {
        console.log(`[ARHIVA] ${candidates.length} fisiere, aleg cel mai mare: "${candidates[0].entryName}"`);
    }
    return candidates[0].getData();
}

async function extractFromRar(buffer) {
    try {
        const { createExtractorFromData } = require('node-unrar-js');
        const extractor = await createExtractorFromData({ data: buffer });
        const list = extractor.getFileList();
        const fileHeaders = [...list.fileHeaders];

        const candidates = fileHeaders.filter(h => {
            const fn = h.name.toLowerCase();
            return fn.endsWith('.srt') || fn.endsWith('.sub');
        });

        if (candidates.length === 0) throw new Error('NO_SRT_IN_RAR');

        candidates.sort((a, b) => (b.packSize || 0) - (a.packSize || 0));
        const target = candidates[0];
        console.log(`[RAR] Extrag: "${target.name}"`);

        const extracted = extractor.extract({ files: [target.name] });
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

    if (!zipUrl) return res.status(400).send('URL lipsa');

    if (source === 'regielive' && zipUrl.includes('/descarca-') && zipUrl.endsWith('-0.zip')) {
        console.log(`[FILTRU] URL invalid RegieLive (id 0), refuz.`);
        return res.status(404).send('Subtitrare indisponibila.');
    }

    const sendSubtitleResponse = (text, responseObj) => {
        const fixedText = fixRomanianDiacritics(text);
        const vttText = srtToVtt(fixedText);
        responseObj.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        responseObj.setHeader('Content-Disposition', 'inline; filename="subtitle.vtt"');
        responseObj.setHeader('Access-Control-Allow-Origin', '*');
        return responseObj.send(vttText);
    };

    if (subtitlesCache.has(zipUrl)) return sendSubtitleResponse(subtitlesCache.get(zipUrl), res);

    if (activeDownloads.has(zipUrl)) {
        try {
            return sendSubtitleResponse(await activeDownloads.get(zipUrl), res);
        } catch {
            return res.status(500).send('Eroare');
        }
    }

    const downloadTask = async () => {
        console.log(`\n[DESCARCARE][${source}] ${zipUrl}`);

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
            rawData = extractFromZip(buffer);
        } else if (archiveType === 'rar') {
            rawData = await extractFromRar(buffer);
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

    activeDownloads.set(zipUrl, queuedTask);

    try {
        const subtitleText = await queuedTask;
        subtitlesCache.set(zipUrl, subtitleText);
        activeDownloads.delete(zipUrl);
        return sendSubtitleResponse(subtitleText, res);
    } catch (error) {
        activeDownloads.delete(zipUrl);
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
