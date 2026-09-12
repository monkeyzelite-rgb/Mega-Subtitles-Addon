require('dotenv').config();

const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { calculateScore, getSourceType } = require('./lib/scorer');
const { searchRegieLive } = require('./lib/regielive');
const { searchTitrari } = require('./lib/titrari');
const { searchSubtitrariNoi } = require('./lib/subtitrarinoi');
const { searchSubsRo } = require('./lib/subsro');

const APP_URL = process.env.APP_URL || 'http://localhost:7000';

function detectFamily(text) {
    return getSourceType(text);
}

    if (/\bremux\b/.test(t)) return 'disc';
    if (/\bblu-?ray\b/.test(t)) return 'disc';
    if (/\bbdrip\b/.test(t)) return 'disc';
    if (/\bbrrip\b/.test(t)) return 'disc';
    if (/\bhddvd\b/.test(t)) return 'disc';
    if (/\buhd\b/.test(t)) return 'disc';

    if (/\bhdtv\b/.test(t)) return 'tv';
    if (/\bpdtv\b/.test(t)) return 'tv';
    if (/\btvrip\b/.test(t)) return 'tv';
    if (/\bdsr\b/.test(t)) return 'tv';

    if (/\bdvdrip\b/.test(t)) return 'dvd';
    if (/\bdvdscr\b/.test(t)) return 'dvd';

    if (/\bhdcam\b/.test(t)) return 'cam';
    if (/\btelecine\b/.test(t)) return 'cam';
    if (/\btelesync\b/.test(t)) return 'cam';
    if (/\bcam\b/.test(t)) return 'cam';

    if (/\bweb-dl\b/.test(t) || /\bwebdl\b/.test(t)) return 'web';
    if (/\bwebrip\b/.test(t)) return 'web';
    if (/\bamzn\b/.test(t) || /\bnf\b/.test(t) || /\bhmax\b/.test(t) || /\bdsnp\b/.test(t)) return 'web';
    if (/\bweb\b/.test(t)) return 'web';

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

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async function(args) {
    // DEBUG — vedem exact ce trimite Nuvio
    console.log('[ARGS COMPLET]', JSON.stringify(args, null, 2));

    const videoFilename = (args.extra && args.extra.filename) ? args.extra.filename : '';
    const videoFilenameLower = videoFilename.toLowerCase();
    const videoFamily = detectFamily(videoFilenameLower);

    if (videoFamily) {
        console.log(`[FILTRU] Familia detectata din filename: ${videoFamily}`);
    } else {
        console.log(`[FILTRU] Nicio familie detectata din filename: "${videoFilename}"`);
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

    const allScored = [];

    for (const { result, name } of sources) {
        if (result.status !== 'fulfilled' || !Array.isArray(result.value)) {
            if (result.status === 'rejected') {
                console.error(`[AGREGATOR] ${name} a picat:`, result.reason?.message);
            }
            continue;
        }

        const subs = result.value.filter(sub => {
            if (!sub.url || typeof sub.url !== 'string' || sub.url.trim() === '') return false;
            if (name === 'regielive' && sub.url.endsWith('-0.zip')) return false;
            return true;
        });

        for (const sub of subs) {
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

            const { score, breakdown } = calculateScore(sub.title, videoFilenameLower, signal, videoFamily);
            const subFamily = detectFamily(sub.title);
            const cleanTitle = decodeHtml(sub.title || name);

            allScored.push({
                id: `${name}-${sub.id}`,
                url: `${APP_URL}/download.vtt?url=${encodeURIComponent(downloadUrl)}&source=${name}&cookie=${encodeURIComponent(sub.cookie || '')}`,
                lang: 'ron',
                title: `${sourceLabel(name)} | ${cleanTitle}`,
                score,
                breakdown,
                subFamily,
                _source: name
            });
        }
    }

    allScored.sort((a, b) => b.score - a.score);

    const seenUrls = new Set();
    const deduped = allScored.filter(sub => {
        if (seenUrls.has(sub.url)) return false;
        seenUrls.add(sub.url);
        return true;
    });

    let finalList = [];

    if (videoFamily) {
        const matching = deduped.filter(s => s.subFamily === videoFamily || s.score >= 100);
        const others = deduped.filter(s => s.subFamily !== videoFamily && s.score < 100);
        const seenSources = new Set();

        finalList = [...matching.slice(0, 8)];
        for (const sub of matching) seenSources.add(sub._source);

        for (const sub of others) {
            if (!seenSources.has(sub._source)) {
                finalList.push(sub);
                seenSources.add(sub._source);
            }
        }

        const fallback = others.slice(0, 3);
        for (const sub of fallback) {
            if (!finalList.find(f => f.url === sub.url)) finalList.push(sub);
        }
    } else {
        // Fara familie — sortam global dar dam bonus la web si disc fata de tv si cam
        const QUALITY_BONUS = {
            'disc': 15,
            'web':  10,
            'dvd':  5,
            'tv':   0,
            'cam':  0
        };

        deduped.forEach(sub => {
            sub.score += QUALITY_BONUS[sub.subFamily] || 0;
        });

        deduped.sort((a, b) => b.score - a.score);
        finalList = deduped.slice(0, 12);
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
        console.log(`  #${i + 1} [${sub._source}] [scor ${sub.score.toFixed(1)}] [${sub.subFamily || '?'}] "${sub.title}" — ${parts.join(', ') || 'fara potriviri'}${marker}`);
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
