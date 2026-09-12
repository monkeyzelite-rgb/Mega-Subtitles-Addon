require('dotenv').config();

const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { calculateScore } = require('./lib/scorer');
const { searchRegieLive } = require('./lib/regielive');
const { searchTitrari } = require('./lib/titrari');
const { searchSubtitrariNoi } = require('./lib/subtitrarinoi');
const { searchSubsRo } = require('./lib/subsro');

const APP_URL = process.env.APP_URL || 'http://localhost:7000';

// IMPORTANT: ordinea conteaza — mai specific primul
// 'web' e dupa 'web-dl' si 'webrip' ca sa nu prinda gresit
// 'hdtv' e separat de 'web' — nu au nicio legatura
const SOURCE_FAMILIES = {
    disc: ['remux', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'hddvd', 'bd', 'uhd'],
    web:  ['web-dl', 'webdl', 'webrip', 'amzn', 'nf', 'hmax', 'dsnp', 'web'],
    tv:   ['hdtv', 'pdtv', 'tvrip', 'dsr'],
    dvd:  ['dvdrip', 'dvdscr', 'r5'],
    cam:  ['cam', 'hdcam', 'telecine', 'telesync']
};

// Detectare mai stricta — folosim word boundary pentru termenii scurti
function detectFamily(text) {
    const t = (text || '').toLowerCase();

    // Verificam mai intai termenii lungi/specifici pentru fiecare familie
    // disc
    if (/\bremux\b/.test(t)) return 'disc';
    if (/\bblu-?ray\b/.test(t)) return 'disc';
    if (/\bbdrip\b/.test(t)) return 'disc';
    if (/\bbrrip\b/.test(t)) return 'disc';
    if (/\bhddvd\b/.test(t)) return 'disc';
    if (/\buhd\b/.test(t)) return 'disc';

    // tv — verificat INAINTE de web ca sa nu prinda hdtv ca web
    if (/\bhdtv\b/.test(t)) return 'tv';
    if (/\bpdtv\b/.test(t)) return 'tv';
    if (/\btvrip\b/.test(t)) return 'tv';
    if (/\bdsr\b/.test(t)) return 'tv';

    // dvd
    if (/\bdvdrip\b/.test(t)) return 'dvd';
    if (/\bdvdscr\b/.test(t)) return 'dvd';

    // cam
    if (/\bhdcam\b/.test(t)) return 'cam';
    if (/\btelecine\b/.test(t)) return 'cam';
    if (/\btelesync\b/.test(t)) return 'cam';
    if (/\bcam\b/.test(t)) return 'cam';

    // web — ultimul, dupa tv
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
    const videoFilename = (args.extra && args.extra.filename) ? args.extra.filename : '';
    const videoFilenameLower = videoFilename.toLowerCase();
    const videoFamily = detectFamily(videoFilenameLower);

    if (videoFamily) {
        console.log(`[FILTRU] Familia detectata din filename: ${videoFamily}`);
    } else {
        console.log(`[FILTRU] Nicio familie detectata — afisez toate`);
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

    // Scoram toate subtitrările din toate sursele
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

            const { score, breakdown } = calculateScore(sub.title, videoFilenameLower, signal);
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

    // Sortam global dupa scor
    allScored.sort((a, b) => b.score - a.score);

    // Deduplicare dupa URL
    const seenUrls = new Set();
    const deduped = allScored.filter(sub => {
        if (seenUrls.has(sub.url)) return false;
        seenUrls.add(sub.url);
        return true;
    });

    // Selectie finala:
    // - Top 8 din familia potrivita (sau toate daca nu avem familie)
    // - + Top 3 din alte familii ca fallback
    // - Garantam cel putin 1 din fiecare sursa care a returnat rezultate
    let finalList = [];
    const seenSources = new Set();

    if (videoFamily) {
        const matching = deduped.filter(s => s.subFamily === videoFamily || s.score >= 100);
        const others = deduped.filter(s => s.subFamily !== videoFamily && s.score < 100);

        // Top 8 din familia potrivita
        finalList = [...matching.slice(0, 8)];

        // Garantam cel putin 1 din fiecare sursa care a returnat ceva
        for (const sub of matching) {
            seenSources.add(sub._source);
        }
        for (const sub of others) {
            if (!seenSources.has(sub._source)) {
                finalList.push(sub);
                seenSources.add(sub._source);
            }
        }

        // + Top 3 fallback din alte familii
        const fallback = others.filter(s => seenSources.has(s._source) || true).slice(0, 3);
        for (const sub of fallback) {
            if (!finalList.find(f => f.url === sub.url)) {
                finalList.push(sub);
            }
        }
    } else {
        // Fara familie detectata — top 12 global
        finalList = deduped.slice(0, 12);
    }

    // Sortam inca o data lista finala
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
