require('dotenv').config();

const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { calculateScore } = require('./lib/scorer');
const { searchRegieLive } = require('./lib/regielive');
const { searchTitrari } = require('./lib/titrari');
const { searchSubtitrariNoi } = require('./lib/subtitrarinoi');
const { searchSubsRo } = require('./lib/subsro');

const APP_URL = process.env.APP_URL || 'http://localhost:7000';

// Familiile de surse pentru filtrare
const SOURCE_FAMILIES = {
    disc: ['remux', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'bd', 'uhd'],
    web:  ['web-dl', 'webdl', 'webrip', 'web', 'amzn', 'nf', 'hmax', 'dsnp'],
    tv:   ['hdtv', 'pdtv', 'tvrip'],
    dvd:  ['dvdrip', 'dvdscr', 'r5'],
    cam:  ['cam', 'ts', 'hdcam', 'telecine', 'telesync']
};

function detectFamily(text) {
    const t = text.toLowerCase();
    for (const [family, keywords] of Object.entries(SOURCE_FAMILIES)) {
        for (const kw of keywords) {
            if (t.includes(kw)) return family;
        }
    }
    return null;
}

async function getCinemetaInfo(imdbId, type) {
    const axios = require('axios');
    try {
        const baseId = imdbId.split(':')[0];
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${baseId}.json`);
        return res.data.meta;
    } catch (err) {
        console.error('[CINEMETA] Eroare:', err.message);
        return null;
    }
}

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async function(args) {
    const videoFilename = (args.extra && args.extra.filename) ? args.extra.filename : '';
    const videoFilenameLower = videoFilename.toLowerCase();

    // Detectam familia sursei filmului redat
    const videoFamily = detectFamily(videoFilenameLower);
    if (videoFamily) {
        console.log(`[FILTRU] Familia detectata din filename: ${videoFamily}`);
    }

    let meta = null;
    const getMetaOnce = async () => {
        if (!meta) meta = await getCinemetaInfo(args.id, args.type);
        return meta;
    };

    const [rlResult, titrariResult, subnoiResult, subsroResult] = await Promise.allSettled([
        searchRegieLive(args.id, args.type, videoFilename),
        (async () => { const m = await getMetaOnce(); return searchTitrari(args.id, args.type, m); })(),
        (async () => { const m = await getMetaOnce(); return searchSubtitrariNoi(args.id, args.type, m); })(),
        (async () => { const m = await getMetaOnce(); return searchSubsRo(args.id, args.type, m); })(),
    ]);

    const allSubs = [];
    const sources = [
        { result: rlResult,      name: 'regielive' },
        { result: titrariResult, name: 'titrari' },
        { result: subnoiResult,  name: 'subtitrarinoi' },
        { result: subsroResult,  name: 'subsro' },
    ];

    for (const { result, name } of sources) {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
            for (const sub of result.value) {
                // Filtru 1: URL valid
                if (!sub.url || typeof sub.url !== 'string' || sub.url.trim() === '') {
                    continue;
                }
                // Filtru 2: URL RegieLive cu id 0
                if (name === 'regielive' && sub.url.endsWith('-0.zip')) {
                    continue;
                }
                allSubs.push({ ...sub, _source: name });
            }
        } else if (result.status === 'rejected') {
            console.error(`[AGREGATOR] ${name} a picat:`, result.reason?.message);
        }
    }

    if (allSubs.length === 0) return { subtitles: [] };

    // Deduplicare cross-source dupa URL
    const seenUrls = new Set();
    const dedupedSubs = allSubs.filter(sub => {
        if (seenUrls.has(sub.url)) return false;
        seenUrls.add(sub.url);
        return true;
    });

    // Scoring unificat
    const scored = dedupedSubs.map(sub => {
        let signal = { type: 'none', value: 0 };

        if (sub._source === 'regielive') {
            const r = parseFloat(sub.rating);
            signal = isNaN(r) ? { type: 'none', value: 0 } : { type: 'rating', value: r };
        } else if (sub._source === 'titrari' || sub._source === 'subtitrarinoi') {
            signal = { type: 'downloads', value: sub.downloads || 0 };
        } else if (sub._source === 'subsro') {
            if (sub.rating !== null && sub.rating !== undefined) {
                signal = { type: 'rating', value: sub.rating };
            } else if (sub.downloads) {
                signal = { type: 'downloads', value: sub.downloads };
            }
        }

        let downloadUrl;
        if (sub._source === 'titrari') {
            downloadUrl = sub.url;
        } else if (sub.url.startsWith('http')) {
            downloadUrl = sub.url;
        } else {
            downloadUrl = `https://subtitrari.regielive.ro${sub.url}`;
        }

        const { score, breakdown } = calculateScore(sub.title, videoFilenameLower, signal);

        return {
            id: `${sub._source}-${sub.id}`,
            url: `${APP_URL}/download.vtt?url=${encodeURIComponent(downloadUrl)}&source=${sub._source}&cookie=${encodeURIComponent(sub.cookie || '')}`,
            lang: 'ron',
            title: `[${sub._source.toUpperCase()}] ${sub.title || sub._source}`,
            score,
            breakdown,
            subFamily: detectFamily(sub.title),
            _source: sub._source
        };
    });

    scored.sort((a, b) => b.score - a.score);

    // Filtrare pe tip sursa — daca filename-ul are o familie clara,
    // aratam intai subtitrari din aceeasi familie, celelalte le pastram ca fallback
    let filtered = scored;
    if (videoFamily && videoFilenameLower) {
        const sameFamily = scored.filter(s => s.subFamily === videoFamily || s.score >= 100);
        const otherFamily = scored.filter(s => s.subFamily !== videoFamily && s.score < 100);

        if (sameFamily.length >= 3) {
            // Avem destule din familia potrivita — le aratam pe alea + primele 5 altele ca backup
            filtered = [...sameFamily, ...otherFamily.slice(0, 5)];
            console.log(`[FILTRU] ${sameFamily.length} din familia "${videoFamily}" + ${Math.min(otherFamily.length, 5)} backup`);
        } else {
            // Prea putine din familia potrivita — aratam tot
            console.log(`[FILTRU] Prea putine din familia "${videoFamily}" (${sameFamily.length}), afisez tot`);
        }
    }

    console.log(`\n[SCOR] Clasament pentru "${videoFilename || '(fara filename)'}"`);
    filtered.forEach((sub, i) => {
        const b = sub.breakdown;
        const parts = [];
        if (b.matchedGroup) parts.push(b.matchedGroup);
        if (b.seEpisode)    parts.push(b.seEpisode);
        if (b.sourceMatch)  parts.push(b.sourceMatch);
        if (b.year)         parts.push(b.year);
        if (b.resMatch)     parts.push(b.resMatch);
        if (b.codec)        parts.push(b.codec);
        if (b.softMatch)    parts.push(b.softMatch);
        if (b.signal)       parts.push(b.signal);
        const marker = i === 0 ? '  <-- ALEASA AUTOMAT' : '';
        console.log(`  #${i + 1} [${sub._source}] [scor ${sub.score.toFixed(1)}] [${sub.subFamily || '?'}] "${sub.title}" — ${parts.join(', ') || 'fara potriviri'}${marker}`);
    });

    const subtitles = filtered.map(sub => ({
        id: sub.id,
        url: sub.url,
        lang: sub.lang,
        title: sub.title
    }));

    return { subtitles };
});

module.exports = builder.getInterface();
