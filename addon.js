const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { calculateScore } = require('./lib/scorer');
const { searchRegieLive, clearSearchCache: clearRL } = require('./lib/regielive');
const { searchTitrari, clearTitrariCache } = require('./lib/titrari');
// const { searchSubtitrariNoi } = require('./lib/subtitrarinoi');
// const { searchSubsRo }        = require('./lib/subsro');

const APP_URL = process.env.APP_URL || 'http://localhost:7000';

// getCinemetaInfo — folosita de Titrari (si viitoarele module) pentru fallback titlu+an
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

    // Meta din Cinemeta — cerut o singura data, partajat intre module
    // (evitam sa facem 3-4 cereri identice la Cinemeta pentru acelasi film)
    let meta = null;
    const getMetaOnce = async () => {
        if (!meta) meta = await getCinemetaInfo(args.id, args.type);
        return meta;
    };

    // Apelam toate sursele in paralel
    const [rlResult, titrariResult /*, subnoiResult, subsroResult */] = await Promise.allSettled([
        searchRegieLive(args.id, args.type, videoFilename),
        (async () => {
            const m = await getMetaOnce();
            return searchTitrari(args.id, args.type, m);
        })(),
        // searchSubtitrariNoi(args.id, args.type),
        // searchSubsRo(args.id, args.type),
    ]);

    // Colectam rezultatele
    const allSubs = [];

    if (rlResult.status === 'fulfilled' && rlResult.value) {
        for (const sub of rlResult.value) {
            allSubs.push({ ...sub, _source: 'regielive' });
        }
    } else if (rlResult.status === 'rejected') {
        console.error('[AGREGATOR] RegieLive a picat:', rlResult.reason?.message);
    }

    if (titrariResult.status === 'fulfilled' && titrariResult.value) {
        for (const sub of titrariResult.value) {
            allSubs.push({ ...sub, _source: 'titrari' });
        }
    } else if (titrariResult.status === 'rejected') {
        console.error('[AGREGATOR] Titrari a picat:', titrariResult.reason?.message);
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
    let scored = dedupedSubs.map(sub => {
        let signal = { type: 'none', value: 0 };

        if (sub._source === 'regielive') {
            const r = parseFloat(sub.rating);
            signal = isNaN(r) ? { type: 'none', value: 0 } : { type: 'rating', value: r };
        } else if (sub._source === 'titrari') {
            signal = { type: 'downloads', value: sub.downloads || 0 };
        }

        const downloadUrl = sub.url.startsWith('http')
            ? sub.url
            : `https://subtitrari.regielive.ro${sub.url}`;

        const { score, breakdown } = calculateScore(sub.title, videoFilenameLower, signal);

        return {
            id: `${sub._source}-${sub.id}`,
            url: `${APP_URL}/download.vtt?url=${encodeURIComponent(downloadUrl)}&source=${sub._source}&cookie=${encodeURIComponent(sub.cookie || '')}`,
            lang: 'ron',
            title: `[${sub._source.toUpperCase()}] ${sub.title || sub._source}`,
            score,
            breakdown,
            _source: sub._source
        };
    });

    scored.sort((a, b) => b.score - a.score);

    // Logging diagnostic
    console.log(`\n[SCOR] Clasament pentru "${videoFilename || '(fara filename)'}"`);
    scored.forEach((sub, i) => {
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
        console.log(`  #${i + 1} [${sub._source}] [scor ${sub.score.toFixed(1)}] "${sub.title}" — ${parts.join(', ') || 'fara potriviri'}${marker}`);
    });

    const subtitles = scored.map(sub => ({
        id: sub.id,
        url: sub.url,
        lang: sub.lang,
        title: sub.title
    }));

    return { subtitles };
});

module.exports = builder.getInterface();
