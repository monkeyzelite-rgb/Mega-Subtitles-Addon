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
const ADMIN_KEY  = process.env.ADMIN_KEY || 'rosubs-admin-2026';

app.use(getRouter(addonInterface));

app.get('/admin/clear-cache', (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(403).send('Cheie invalida.');
    const downloadsCleared = subtitlesCache.size;
    subtitlesCache.clear();
    activeDownloads.clear();
    const searchesCleared = clearSearchCache();
    res.send(`Cache golit: ${downloadsCleared} subtitrari + ${searchesCleared} cautari.`);
});

app.get(['/download', '/download.vtt'], async (req, res) => {
    const zipUrl = req.query.url;
    const source = req.query.source || 'regielive';
    const sessionCookie = req.query.cookie || '';

    if (!zipUrl) return res.status(400).send('URL lipsa');

    const sendSubtitleResponse = (text, responseObj) => {
        const vttText = srtToVtt(text);
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
        } else if (source === 'subsro') {
            headers['X-API-Key'] = process.env.SUBSRO_API_KEY || '';
        }

        const response = await axios({
            method: 'get',
            url: zipUrl,
            responseType: 'arraybuffer',
            headers
        });

        let zip;
        try {
            zip = new AdmZip(response.data);
        } catch (e) {
            const contentType = response.headers['content-type'] || 'necunoscut';
            const fullBody = Buffer.from(response.data).toString('utf8');
            const titleMatch = fullBody.match(/<title>([\s\S]*?)<\/title>/i);
            console.error(`[X][${source}] Fisierul nu e ZIP!`);
            console.error(`    Status: ${response.status} | Content-Type: ${contentType}`);
            console.error(`    <title>: ${titleMatch ? titleMatch[1].trim() : '(fara title)'}`);
            console.error(`    Primele 500 chars: ${fullBody.slice(0, 500)}`);
            throw new Error('NOT_A_ZIP');
        }

        const zipEntries = zip.getEntries();
        let subtitleEntry = null;

        const candidates = zipEntries.filter(e => {
            const fn = e.entryName.toLowerCase();
            const base = fn.split('/').pop();
            return !fn.includes('__macosx') && !base.startsWith('.') &&
                   (fn.endsWith('.srt') || fn.endsWith('.sub'));
        });

        if (candidates.length > 0) {
            candidates.sort((a, b) => (b.header.size || 0) - (a.header.size || 0));
            subtitleEntry = candidates[0];
            if (candidates.length > 1) {
                console.log(`[ARHIVA] ${candidates.length} fisiere, aleg cel mai mare: "${subtitleEntry.entryName}"`);
            }
        }

        if (!subtitleEntry) {
            subtitleEntry = zipEntries.find(e => e.entryName.toLowerCase().endsWith('.txt'));
        }

        if (!subtitleEntry) throw new Error('NO_SRT');

        const rawData  = subtitleEntry.getData();
        const detected = jschardet.detect(rawData);
        let encoding   = 'windows-1250';
        if (detected && detected.encoding) {
            const enc = detected.encoding.toLowerCase();
            if (enc.includes('utf') || enc === 'ascii') encoding = enc;
        }

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
