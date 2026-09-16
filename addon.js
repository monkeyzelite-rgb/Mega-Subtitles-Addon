require('dotenv').config();

const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { calculateScore, getSourceType, detectFramerate } = require('./lib/scorer');
const { searchRegieLive } = require('./lib/regielive');
const { searchTitrari } = require('./lib/titrari');
const { searchSubtitrariNoi } = require('./lib/subtitrarinoi');
const { searchSubsRo } = require('./lib/subsro');

const APP_URL = process.env.APP_URL || 'http://localhost:7000';

function detectFamily(text) {
    return getSourceType(text);
}

function detectFamilyFromSize(videoSizeBytes, contentType) {
    if (!videoSizeBytes) return null;
    const size = parseInt(videoSizeBytes);
    if (isNaN(size)) return null;

    const GB = 1024 * 1024 * 1024;
    const MB = 1024 * 1024;

    if (contentType === 'series') {
        if (size > 3 * GB)   return 'disc';
        if (size > 800 * MB) return 'web';
        if (size > 200 * MB) return 'web';
        return null;
    } else {
        if (size > 15 * GB)  return 'disc';
        if (size > 6 * GB)   return 'web';
        if (size > 2 * GB)   return 'web';
        if (size > 500 * MB) return 'web';
        return null;
    }
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
    const videoSize = args.extra && args.extra.videoSize ? args.extra.videoSize : null;

    // Sezon/episod din ID-ul Stremio (tt.../sezon/episod), NU din filename.
    // Filename-ul poate fi un placeholder opac (ex: un hash de la o sursa
    // debrid/cache: "TIJG5EPGMC5X4CDE") care nu contine nicio informatie
    // reala — daca scorer-ul si selectorul de fisier din arhiva s-ar baza
    // doar pe regex peste filename, ar alege un episod complet gresit din
    // pachetele multi-episod (s-a intamplat: episoade random extrase din
    // arhive, niciunul cel cerut).
    let knownSeason = null, knownEpisode = null;
    if (args.type === 'series') {
        const idParts = args.id.split(':');
        knownSeason = idParts[1] ? parseInt(idParts[1], 10) : null;
        knownEpisode = idParts[2] ? parseInt(idParts[2], 10) : null;
    }

    let videoFamily = detectFamily(videoFilenameLower);
    let familySource = 'filename';
    let videoFamilyIsGuess = false;

    if (!videoFamily && videoSize) {
        videoFamily = detectFamilyFromSize(videoSize, args.type);
        familySource = `videoSize(${(parseInt(videoSize) / (1024 * 1024 * 1024)).toFixed(1)}GB)`;
        // Spre deosebire de o detectie din numele fisierului (care contine explicit
        // "WEB-DL"/"BluRay"), asta e o GHICIRE dupa marime — pragurile sunt calibrate
        // pt. filme/episoade de durata normala si pot clasifica gresit un episod
        // scurt cu bitrate mare (anime, encoduri de calitate) drept "disc". Marcam
        // ca sa nu fie folosita pentru penalizari agresive in scorer.js, doar pt.
        // bonusuri (vezi calculateScore).
        videoFamilyIsGuess = true;
    }

    const videoFps = detectFramerate(videoFilenameLower);

    if (videoFamily) {
        console.log(`[FILTRU] Familia detectata din ${familySource}: ${videoFamily}`);
    } else {
        console.log(`[FILTRU] Nicio familie detectata`);
    }
    if (videoFps) {
        console.log(`[FPS] Framerate detectat: ${videoFps}`);
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

            const subFamily = detectFamily(sub.title);
            // Sursele "low" (DVDRip/CAM/telesync etc.) sunt izgonite complet — userul
            // vizioneaza mereu din surse BluRay sau WEB-DL, deci un candidat DVDRip nu
            // are ce cauta nici macar ca fallback manual in lista din Stremio.
            if (subFamily === 'low') continue;

            const { score, breakdown } = calculateScore(sub.title, videoFilenameLower, signal, videoFamily, knownSeason, knownEpisode, videoFamilyIsGuess);
            // Titlul mentioneaza explicit un ALT sezon decat cel cerut — nu e risc de
            // sincronizare, e continut garantat gresit. Eliminam complet, nu doar
            // penalizam (vezi lib/scorer.js unde se seteaza acest flag).
            if (breakdown.wrongSeason) continue;
            const cleanTitle = decodeHtml(sub.title || name);

            const seParam = (knownSeason && knownEpisode) ? `&season=${knownSeason}&episode=${knownEpisode}` : '';
            allScored.push({
                id: `${name}-${sub.id}`,
                // Trimitem si filename-ul (vf) + sezon/episod cunoscut, ca server.js sa
                // aleaga fisierul corect din arhiva chiar daca vf e un placeholder opac
                url: `${APP_URL}/download.vtt?url=${encodeURIComponent(downloadUrl)}&source=${name}&cookie=${encodeURIComponent(sub.cookie || '')}&vf=${encodeURIComponent(videoFilename)}${seParam}`,
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

        let fallbackCount = 0;
        for (const sub of others) {
            if (fallbackCount >= 3) break;
            if (!finalList.find(f => f.url === sub.url)) {
                finalList.push(sub);
                fallbackCount++;
            }
        }
    } else {
        finalList = deduped.slice(0, 12);
    }

    // "hdtv" ramane in lista (rip-urile TV au de obicei acelasi timing ca WEB-DL),
    // dar niciodata aleasa automat peste o varianta disc/web — o impingem mereu la
    // finalul listei, indiferent de scor. In interiorul fiecarui grup, sortam tot
    // dupa scor ca inainte.
    finalList.sort((a, b) => {
        const aHdtv = a.subFamily === 'hdtv';
        const bHdtv = b.subFamily === 'hdtv';
        if (aHdtv !== bHdtv) return aHdtv ? 1 : -1;
        return b.score - a.score;
    });

    console.log(`\n[SCOR] Clasament final pentru "${videoFilename || '(fara filename)'}"`);
    finalList.forEach((sub, i) => {
        const b = sub.breakdown;
        const parts = [];
        if (b.matchedGroup) parts.push(b.matchedGroup);
        if (b.framerate)    parts.push(b.framerate);
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
