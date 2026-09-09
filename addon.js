require('dotenv').config();

const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { calculateScore } = require('./lib/scorer');
const { searchRegieLive } = require('./lib/regielive');
const { searchTitrari } = require('./lib/titrari');
const { searchSubtitrariNoi } = require('./lib/subtitrarinoi');
const { searchSubsRo } = require('./lib/subsro');

const APP_URL = process.env.APP_URL || 'http://localhost:7000';

const SOURCE_FAMILIES = {
    disc: ['remux', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'hddvd', 'bd', 'uhd'],
    web:  ['web-dl', 'webdl', 'webrip', 'web', 'amzn', 'nf', 'hmax', 'dsnp'],
    tv:   ['hdtv', 'pdtv', 'tvrip'],
    dvd:  ['dvdrip', 'dvdscr', 'r5'],
    cam:  ['cam', 'ts', 'hdcam', 'telecine', 'telesync']
};

function detectFamily(text) {
    const t = (text || '').toLowerCase();
    for (const [family, keywords] of Object.entries(SOURCE_FAMILIES)) {
        for (const kw of keywords) {
            if (t.includes(kw)) return family;
        }
    }
    return null;
}

function sourceLabel(source) {
    const labels = {
        'regielive':     'RegieLive',
        'titrari':       'Titrari.ro',
        'subtitrarinoi': 'Subtitrari-noi.ro',
        'subsro':        'Subs.ro'
    };
    return labels[source] || source;
}

function decodeHtml(text) {
    return (text || '')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
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

function selectBest(subs, videoFamily, MAX_MATCH = 3, MAX_FALLBACK = 1) {
    const matching = subs.filter(s => !videoFamily || s.subFamily === videoFamily || s.score >= 100);
    const fallback = subs.filter(s => videoFamily && s.subFamily !== videoFamily && s.score < 100);
    return [
        ...matching.slice(0, MAX_MATCH),
        ...fallback.slice(0, MAX_FALLBACK)
    ];
}

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async function(args) {
    const videoFilename = (args.extra && args.extra.filename) ? args.extra.filename : '';
    const videoFilenameLower = videoFilename.toLowerCase();
    const videoFamily = detectFamily(videoFilenameLower);

    if (videoFamily) {
        console.log(`[FILTRU] Familia detectata: ${videoFamily}`);
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

    const sources = [
        { result: rlResult,      name: 'regielive' },
        { result: titrariResult, name: 'titrari' },
        { result: subnoiResult,  name: 'subtitrarinoi' },
        { result: subsroResult,  name: 'subsro' },
    ];

    const scoredPerSource = {};

    for (const { result, name } of sources) {
        if (result.status !== 'fulfilled' || !Array.isArray(result.value)) {
            if (result.status === 'rejected') {
                console.error(`[AGREGATOR] ${name} a picat:`, result.reason?.message);
            }
            scoredPerSource[name] = [];
            continue;
        }

        const subs = result.value.filter(sub => {
            if (!sub.url || typeof sub.url !== 'string' || sub.url.trim() === '') return false;
            if (name === 'regielive' && sub.url.endsWith('-0.zip')) return false;
            return true;
        });

        scoredPerSource[name] = subs.map(sub => {
            let signal = { type: 'none', value: 0 };

            if (name === 'regielive') {
                const r = parseFloat(sub.rating);
                signal = isNaN(r) ? { type: 'none', value: 0 } : { type: 'rating', value: r };
            } else if (name === 'titrari' || name === 'subtitrarinoi') {
                signal = { type: 'downloads', value: sub.downloads || 0 };
            } else if (name === 'subsro') {
                if (sub.rating != null) signal = { type: 'rating', value: sub.rating };
                else if (sub.downloads) signal = { type: 'downloads', value: sub.downloads };
            }

            let downloadUrl;
            if (name === 'titrari') {
                downloadUrl = sub.url;
            } else if (sub.url.startsWith('http')) {
                downloadUrl = sub.url;
            } else {
                downloadUrl = `https://subtitrari.regielive.ro${sub.url}`;
            }

            const { score, breakdown } = calculateScore(sub.title, videoFilenameLower, signal);
            const cleanTitle = decodeHtml(sub.title || name);

            return {
                id: `${name}-${sub.id}`,
                url: `${APP_URL}/download.vtt?url=${encodeURIComponent(downloadUrl)}&source=${name}&cookie=${encodeURIComponent(sub.cookie || '')}`,
                // lang afiseaza "Romana" + sursa ca linie secundara in Nuvio
                lang: `ron`,
                title: `${sourceLabel(name)} | ${cleanTitle}`,
                score,
                breakdown,
                subFamily: detectFamily(sub.title),
                _source: name
            };
        }).sort((a, b) => b.score - a.score);
    }

    const finalList = [];
    const seenUrls = new Set();

    for (const name of ['regielive', 'titrari', 'subtitrarinoi', 'subsro']) {
        const best = selectBest(scoredPerSource[name] || [], videoFamily);
        console.log(`[SELECTIE] ${name}: ${best.length} subtitrari alese din ${(scoredPerSource[name] || []).length} totale`);

        for (const sub of best) {
            if (seenUrls.has(sub.url)) continue;
            seenUrls.add(sub.url);
            finalList.push(sub);
        }
    }

    finalList.sort((a, b) => b.score - a.score);

    console.log(`\n[SCOR] Clasament final pentru "${videoFilename || '(fara filename)'}"`);
    finalList.forEach((sub, i) => {
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

    const subtitles = finalList.map(sub => ({
        id: sub.id,
        url: sub.url,
        lang: sub.lang,
        title: sub.title
    }));

    return { subtitles };
});

module.exports = builder.getInterface();
