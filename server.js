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
const cacheDb = require('./lib/cacheStore');
const BoundedCache = require('./lib/boundedCache');

// Pe Vercel nu exista un proces persistent intre cereri — coada globala de
// 1.5s intre descarcari (gandita pt. un server single-user, local/Pi) ar doar
// incetini inutil accesul concurent al mai multor utilizatori, fara sa
// protejeze de fapt nimic (RegieLive, singura sursa cu limita stricta
// documentata, e deja protejata separat, distribuit — vezi lib/regielive.js).
// Acelasi semnal decide si daca merita pornit cleanup-ul periodic mai jos —
// pe Vercel fiecare invocare e scurta si separata, deci un setInterval n-ar
// mai apuca sa faca nimic util.
const IS_SERVERLESS = !!process.env.UPSTASH_REDIS_REST_URL;

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

// Cache in memorie — layer rapid peste SQLite. Continutul deja e persistat
// pe disc (90 zile), deci acest L1 nu trebuie sa fie nemarginit — il tinem
// mic si dam evacuare LRU, altfel textul complet al fiecarei subtitrari
// descarcate vreodata ramanea in heap pentru totdeauna.
const memCache = new BoundedCache({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 200 });
const activeDownloads = new Map();
let globalDownloadQueue = Promise.resolve();

const RL_API_KEY = 'API-BAZARR-YTZ-SL';
const ADMIN_KEY = process.env.ADMIN_KEY || 'rosubs-admin-2026';
const TITRARI_COOKIE = process.env.TITRARI_COOKIE || '';

app.use(getRouter(addonInterface));

app.get('/admin/clear-cache', async (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(403).send('Cheie invalida.');
    const memCleared = memCache.size;
    memCache.clear();
    activeDownloads.clear();
    const searchesCleared = clearSearchCache();
    const dbCleared = await cacheDb.clearAll();
    res.send(`Cache golit: ${memCleared} memorie + ${searchesCleared} cautari + ${dbCleared} intrari ${cacheDb.backend}.`);
});

app.get('/admin/cache-stats', async (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(403).send('Cheie invalida.');
    const s = await cacheDb.stats();
    res.json({
        memorie: memCache.size,
        [cacheDb.backend]: s
    });
});

function detectArchiveType(buffer) {
    if (buffer.length < 4) return 'unknown';
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) return 'zip';
    if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) return 'rar';
    return 'unknown';
}

// Cate un nivel de recursie e suficient pentru cazul real intalnit (pachet
// "serie completa" = un rar/zip exterior ce contine cate un rar/zip per sezon)
// si opreste orice risc de bucla / arhiva-in-arhiva-in-arhiva construita
// malitios. Limita de marime evita sa decomprimam ceva neasteptat de mare
// doar pentru ca "pare" un pachet per-sezon legitim.
const MAX_NESTED_DEPTH = 1;
// Un pachet de subtitrari pt. un singur sezon nu ar trebui sa depaseasca asta.
// Verificam marimea declarata in header INAINTE de decomprimare (filtru rapid)
// SI marimea reala a bufferului dupa decomprimare (header-ul poate fi
// falsificat intr-o arhiva construita malitios — marime mica declarata,
// continut real mult mai mare, clasicul "decompression bomb").
const MAX_NESTED_ARCHIVE_SIZE = 20 * 1024 * 1024; // 20MB

// Un .srt/.sub, oricat de incarcat cu mai multe limbi sau segmente, nu ar trebui
// sa depaseasca asta. Aplicam limita si pe marimea DECLARATA (filtru rapid,
// inainte de decomprimare) si pe cea REALA dupa decomprimare — un header
// falsificat intr-o arhiva construita malitios poate declara o marime mica
// si decomprima la ceva mult mai mare (decompression bomb).
const MAX_SUBTITLE_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// /download accepta un URL controlat de client. Fara verificare, oricine poate
// cere serverului sa descarce si sa parseze orice arhiva de pe orice domeniu
// (risc SSRF + amplificare pt. decompression-bomb pe un domeniu strain). Legam
// fiecare sursa suportata la domeniul ei real (verificat direct in cod, nu presupus).
const ALLOWED_DOWNLOAD_DOMAINS = {
    regielive:     ['regielive.ro'],
    titrari:       ['titrari.ro'],
    subtitrarinoi: ['subtitrari-noi.ro'],
    subsro:        ['subs.ro'],
};
const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024; // 100MB — generos pt. orice arhiva reala de subtitrari

function isAllowedDownloadHost(hostname, source) {
    const allowedDomains = ALLOWED_DOWNLOAD_DOMAINS[source];
    if (!allowedDomains) return false;
    const h = (hostname || '').toLowerCase();
    return allowedDomains.some(domain => h === domain || h.endsWith(`.${domain}`));
}

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

function scoreArchiveEntry(entryName, videoFilename, knownSeason, knownEpisode) {
    if (!videoFilename && !(knownSeason && knownEpisode)) return 0;

    const entry = entryName.toLowerCase();
    const video = (videoFilename || '').toLowerCase();
    let score = 0;

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

    for (const res of ['2160p', '1080p', '720p', '480p']) {
        if (video.includes(res) && entry.includes(res)) { score += 40; break; }
    }

    const groupMatch = video.match(/-([a-z0-9]{2,20})(?:\.[a-z0-9]{2,4})?$/i);
    if (groupMatch) {
        const group = groupMatch[1].toLowerCase();
        if (group.length >= 3 && entry.includes(group)) score += 80;
    }

    for (const codec of ['x265', 'hevc', 'x264', 'h264', 'av1']) {
        if (video.includes(codec) && entry.includes(codec)) { score += 20; break; }
    }

    // Preferam sezonul/episodul cunoscut din ID-ul Stremio (sigur) in loc de regex
    // pe numele fisierului video — care poate fi un placeholder opac de la o sursa
    // debrid (altfel toti candidatii dintr-o arhiva multi-episod scoreaza 0 si
    // alegerea devine esentialmente aleatorie dupa marime, extragand episod gresit).
    const seMatch = video.match(/s(\d{1,2})e(\d{1,2})/i);
    const seSeason  = knownSeason  ? String(knownSeason)  : (seMatch ? seMatch[1] : null);
    const seEpisode = knownEpisode ? String(knownEpisode) : (seMatch ? seMatch[2] : null);
    if (seSeason && seEpisode) {
        const se = `s${seSeason.padStart(2,'0')}e${seEpisode.padStart(2,'0')}`;
        if (entry.includes(se)) score += 120;
    }

    return score;
}

// Un pachet "serie completa" e adesea o arhiva exterioara ce contine cate o
// arhiva per sezon (ex: "Supernatural.S04.720p.BluRay.x264-Mixed Groups.rar").
// Daca stim sigur sezonul cerut (din ID-ul Stremio) si EXACT una dintre
// arhivele imbricate il mentioneaza, o putem identifica fara ambiguitate —
// altfel (zero sau mai multe potriviri) nu ghicim.
function findSeasonMatchedNestedArchive(nestedNames, knownSeason) {
    const season = String(knownSeason);
    const pattern = new RegExp(`\\bs0?${season}\\b|\\bseason[\\s._-]*0?${season}\\b|\\bsezonul[\\s._-]*0?${season}\\b`, 'i');
    const matches = nestedNames.filter(name => pattern.test(name));
    return matches.length === 1 ? matches[0] : null;
}

function pickBestSubtitleFile(candidates, videoFilename, knownSeason, knownEpisode) {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const scored = candidates.map(c => ({
        entry: c,
        matchScore: scoreArchiveEntry(c.name, videoFilename, knownSeason, knownEpisode),
        size: c.size || 0
    }));

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

async function extractFromZip(buffer, videoFilename, knownSeason, knownEpisode, depth = 0) {
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    const candidates = zipEntries
        .filter(e => {
            const fn = e.entryName.toLowerCase();
            const base = fn.split('/').pop();
            return !fn.includes('__macosx') && !base.startsWith('.') &&
                   (fn.endsWith('.srt') || fn.endsWith('.sub')) &&
                   (e.header.size || 0) <= MAX_SUBTITLE_FILE_SIZE;
        })
        .map(e => ({ name: e.entryName, size: e.header.size || 0, _entry: e }));

    if (candidates.length === 0) {
        const txt = zipEntries.find(e => e.entryName.toLowerCase().endsWith('.txt'));
        if (txt) return txt.getData();

        const nested = zipEntries.filter(e => /\.(rar|zip)$/i.test(e.entryName));
        if (nested.length > 0) {
            const matchedName = (knownSeason && depth < MAX_NESTED_DEPTH)
                ? findSeasonMatchedNestedArchive(nested.map(e => e.entryName), knownSeason)
                : null;
            const matched = matchedName ? nested.find(e => e.entryName === matchedName) : null;

            if (matched && (matched.header.size || 0) <= MAX_NESTED_ARCHIVE_SIZE) {
                console.log(`[ZIP] Arhiva contine ${nested.length} arhive imbricate — recurg in cea a sezonului cunoscut: "${matched.entryName}"`);
                const nestedBuffer = matched.getData();
                if (nestedBuffer.length <= MAX_NESTED_ARCHIVE_SIZE) {
                    const nestedType = detectArchiveType(nestedBuffer);
                    if (nestedType === 'zip') return await extractFromZip(nestedBuffer, videoFilename, knownSeason, knownEpisode, depth + 1);
                    if (nestedType === 'rar') return await extractFromRar(nestedBuffer, videoFilename, knownSeason, knownEpisode, depth + 1);
                } else {
                    console.error(`[ZIP] Arhiva imbricata "${matched.entryName}" a decomprimat la ${nestedBuffer.length} bytes — peste limita reala, o ignor (header posibil falsificat).`);
                }
            }

            console.error(`[ZIP] Arhiva contine ${nested.length} arhive imbricate (probabil pachet multi-sezon), nu extragem recursiv: ${nested.map(e => e.entryName).join(', ')}`);
            throw new Error('NESTED_ARCHIVE_UNSUPPORTED');
        }
        throw new Error('NO_SRT_IN_ZIP');
    }

    const best = pickBestSubtitleFile(candidates, videoFilename, knownSeason, knownEpisode);
    const data = best._entry.getData();
    if (data.length > MAX_SUBTITLE_FILE_SIZE) throw new Error('SUBTITLE_TOO_LARGE');
    return data;
}

async function extractFromRar(buffer, videoFilename, knownSeason, knownEpisode, depth = 0) {
    try {
        const { createExtractorFromData } = require('node-unrar-js');
        const extractor = await createExtractorFromData({ data: buffer });
        const list = extractor.getFileList();
        const fileHeaders = [...list.fileHeaders];

        const candidates = fileHeaders
            .filter(h => {
                const fn = h.name.toLowerCase();
                return (fn.endsWith('.srt') || fn.endsWith('.sub')) &&
                       (h.unpSize || h.packSize || 0) <= MAX_SUBTITLE_FILE_SIZE;
            })
            .map(h => ({ name: h.name, size: h.unpSize || h.packSize || 0 }));

        if (candidates.length === 0) {
            // Unele pachete "serie completa" sunt o arhiva ce contine alte arhive
            // imbricate (cate un .rar per sezon). Daca stim sigur sezonul cerut si
            // EXACT una dintre ele il mentioneaza, recursam o singura data in ea —
            // altfel (sezon necunoscut sau ambiguu) logam explicit si renuntam, ca
            // sa fie clar dintr-o privire in loguri de ce a esuat descarcarea asta.
            const nested = fileHeaders.filter(h => /\.(rar|zip)$/i.test(h.name));
            if (nested.length > 0) {
                const matchedName = (knownSeason && depth < MAX_NESTED_DEPTH)
                    ? findSeasonMatchedNestedArchive(nested.map(h => h.name), knownSeason)
                    : null;
                const matchedHeader = matchedName ? nested.find(h => h.name === matchedName) : null;
                const matchedSize = matchedHeader ? (matchedHeader.unpSize || matchedHeader.packSize || 0) : 0;

                if (matchedHeader && matchedSize <= MAX_NESTED_ARCHIVE_SIZE) {
                    console.log(`[RAR] Arhiva contine ${nested.length} arhive imbricate — recurg in cea a sezonului cunoscut: "${matchedHeader.name}"`);
                    const nestedExtracted = extractor.extract({ files: [matchedHeader.name] });
                    const nestedFiles = [...nestedExtracted.files];
                    if (nestedFiles.length > 0 && nestedFiles[0].extraction) {
                        const nestedBuffer = Buffer.from(nestedFiles[0].extraction);
                        if (nestedBuffer.length <= MAX_NESTED_ARCHIVE_SIZE) {
                            const nestedType = detectArchiveType(nestedBuffer);
                            if (nestedType === 'zip') return await extractFromZip(nestedBuffer, videoFilename, knownSeason, knownEpisode, depth + 1);
                            if (nestedType === 'rar') return await extractFromRar(nestedBuffer, videoFilename, knownSeason, knownEpisode, depth + 1);
                        } else {
                            console.error(`[RAR] Arhiva imbricata "${matchedHeader.name}" a decomprimat la ${nestedBuffer.length} bytes — peste limita reala, o ignor (header posibil falsificat).`);
                        }
                    }
                }

                console.error(`[RAR] Arhiva contine ${nested.length} arhive imbricate (probabil pachet multi-sezon), nu extragem recursiv: ${nested.map(h => h.name).join(', ')}`);
                throw new Error('NESTED_ARCHIVE_UNSUPPORTED');
            }
            throw new Error('NO_SRT_IN_RAR');
        }

        const best = pickBestSubtitleFile(candidates, videoFilename, knownSeason, knownEpisode);
        console.log(`[RAR] Extrag: "${best.name}"`);

        const extracted = extractor.extract({ files: [best.name] });
        const files = [...extracted.files];
        if (files.length === 0) throw new Error('RAR_EXTRACT_FAILED');

        const finalBuffer = Buffer.from(files[0].extraction);
        if (finalBuffer.length > MAX_SUBTITLE_FILE_SIZE) throw new Error('SUBTITLE_TOO_LARGE');
        return finalBuffer;
    } catch (err) {
        console.error('[RAR] Eroare extractie:', err.message);
        throw new Error('RAR_EXTRACT_FAILED');
    }
}

app.get(['/download', '/download.vtt'], async (req, res) => {
    const zipUrl = req.query.url;
    const source = req.query.source || 'regielive';
    const sessionCookie = req.query.cookie || '';
    const videoFilename = req.query.vf || '';
    const knownSeason  = req.query.season  ? parseInt(req.query.season, 10)  : null;
    const knownEpisode = req.query.episode ? parseInt(req.query.episode, 10) : null;

    if (!zipUrl) return res.status(400).send('URL lipsa');

    // Fara asta, orice client (nu doar Stremio) putea cere serverului sa
    // descarce si parseze orice URL, de pe orice domeniu — risc SSRF + vector
    // de amplificare pt. un atac de tip decompression-bomb pe un domeniu strain.
    let parsedUrl;
    try {
        parsedUrl = new URL(zipUrl);
    } catch {
        return res.status(400).send('URL invalid.');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return res.status(400).send('Protocol nepermis.');
    }
    if (!isAllowedDownloadHost(parsedUrl.hostname, source)) {
        console.error(`[SECURITATE] URL refuzat — domeniul "${parsedUrl.hostname}" nu e permis pentru sursa "${source}".`);
        return res.status(403).send('Domeniu nepermis pentru aceasta sursa.');
    }

    if (source === 'regielive' && zipUrl.includes('/descarca-') && zipUrl.endsWith('-0.zip')) {
        console.log(`[FILTRU] URL invalid RegieLive (id 0), refuz.`);
        return res.status(404).send('Subtitrare indisponibila.');
    }

    const cacheKey = `${zipUrl}::${videoFilename}`;

    const sendSubtitleResponse = (text, responseObj) => {
        const fixedText = fixRomanianDiacritics(text);
        const vttText = srtToVtt(fixedText);
        responseObj.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        responseObj.setHeader('Content-Disposition', 'inline; filename="subtitle.vtt"');
        responseObj.setHeader('Access-Control-Allow-Origin', '*');
        return responseObj.send(vttText);
    };

    // 1. Cache in memorie (cel mai rapid)
    if (memCache.has(cacheKey)) {
        console.log(`[CACHE-MEM] Hit: ${videoFilename || zipUrl}`);
        return sendSubtitleResponse(memCache.get(cacheKey), res);
    }

    // 2. Cache persistent (SQLite local sau Redis pe Vercel) — supravietuieste repornirii
    const fromDb = await cacheDb.getSubtitle(cacheKey);
    if (fromDb) {
        console.log(`[CACHE-DB] Hit: ${videoFilename || zipUrl}`);
        memCache.set(cacheKey, fromDb);
        return sendSubtitleResponse(fromDb, res);
    }

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
            maxRedirects: 5,
            maxContentLength: MAX_DOWNLOAD_SIZE,
            maxBodyLength: MAX_DOWNLOAD_SIZE,
            // Un redirect poate duce in afara domeniului validat mai sus — verificam
            // si fiecare hop, nu doar URL-ul initial.
            beforeRedirect: (options) => {
                if (!isAllowedDownloadHost(options.hostname, source)) {
                    throw new Error(`Redirect catre domeniu nepermis: ${options.hostname}`);
                }
            }
        });

        const buffer = Buffer.from(response.data);
        const archiveType = detectArchiveType(buffer);
        console.log(`[ARHIVA] Tip detectat: ${archiveType} (${buffer.length} bytes)`);

        let rawData;

        if (archiveType === 'zip') {
            rawData = await extractFromZip(buffer, videoFilename, knownSeason, knownEpisode);
        } else if (archiveType === 'rar') {
            rawData = await extractFromRar(buffer, videoFilename, knownSeason, knownEpisode);
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

    const queuedTask = IS_SERVERLESS
        ? downloadTask()
        : new Promise((resolve, reject) => {
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
        // Salvam in ambele layere de cache
        memCache.set(cacheKey, subtitleText);
        await cacheDb.setSubtitle(cacheKey, subtitleText);
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

// Curatarea periodica are sens doar pe un proces persistent (local/Pi) — pe
// Vercel fiecare invocare e scurta si separata, iar backend-ul Redis oricum
// expira singur intrarile prin TTL nativ (cleanup() e no-op acolo).
if (!IS_SERVERLESS) {
    setInterval(() => cacheDb.cleanup(), 24 * 60 * 60 * 1000);
}

// Pe Vercel, server.js e doar cerut ca modul (Vercel gestioneaza singur
// invocarea HTTP prin app-ul exportat mai jos) — nu trebuie sa asculte pe un
// port. Local (`node server.js`, sau viitor pe Raspberry Pi), ramane neschimbat.
if (require.main === module) {
    const port = process.env.PORT || 7000;
    app.listen(port, async () => {
        console.log(`RO Subs addon ruleaza la http://127.0.0.1:${port}/manifest.json`);
        const s = await cacheDb.stats();
        if (s.available && cacheDb.backend === 'sqlite') {
            console.log(`[CACHE-DB] ${s.searches} cautari, ${s.subtitles} subtitrari, ${s.sizeMB} MB`);
        } else if (s.available) {
            console.log(`[CACHE-DB] Backend ${cacheDb.backend}, ${s.keys ?? '?'} chei.`);
        }
    });
}

module.exports = app;
