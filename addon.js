require('dotenv').config();

const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { calculateScore, getSourceType, detectFramerate, hasKeyword } = require('./lib/scorer');
const { searchRegieLive } = require('./lib/regielive');
const { searchTitrari } = require('./lib/titrari');
const { searchSubtitrariNoi } = require('./lib/subtitrarinoi');
const { searchSubsRo } = require('./lib/subsro');

// RENDER_EXTERNAL_URL vine automat de la Render pe orice Web Service — preferat
// fata de APP_URL (setat manual) ca sa nu trebuiasca actualizat dupa fiecare
// schimbare de nume/URL al serviciului.
const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || 'http://localhost:7000';

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

// Etichete de afisare (doar cosmetic, in titlul trimis catre Stremio) — nu
// influenteaza subFamily/scorul, care raman calculate din getSourceType().
// Ordinea conteaza: cuvintele-cheie mai specifice sunt verificate inaintea
// celor generice (ex. "bdrip" inaintea lui "bd"), la fel ca in lib/scorer.js.
const QUALITY_DISPLAY_LABELS = {
    disc: [
        ['bdremux', 'BDRemux'], ['remux', 'Remux'], ['blu-ray', 'BluRay'], ['bluray', 'BluRay'],
        ['bdrip', 'BDRip'], ['brrip', 'BRRip'], ['uhdbd', 'UHD BluRay'], ['uhd', 'UHD'],
        ['hddvd', 'HD-DVD'], ['bd', 'BD']
    ],
    web: [
        ['web-dl', 'WEB-DL'], ['webdl', 'WEB-DL'], ['web.dl', 'WEB-DL'],
        ['web-rip', 'WEBRip'], ['webrip', 'WEBRip'],
        ['amzn', 'AMZN'], ['nf', 'NF'], ['hmax', 'HMAX'], ['dsnp', 'DSNP'], ['web', 'WEB']
    ],
    hdtv: [
        ['hdtv', 'HDTV'], ['pdtv', 'PDTV'], ['dsrip', 'DSR'], ['dsr', 'DSR'], ['tvrip', 'TVRip']
    ]
};

function detectQualityLabel(text, family) {
    const table = QUALITY_DISPLAY_LABELS[family];
    if (!table) return null;
    // Aceeasi potrivire pe token ca getSourceType() — cu includes(), un titlu ca
    // "Confession.2020.WEB" primea eticheta "NF" (din "coNFession").
    for (const [keyword, label] of table) {
        if (hasKeyword(text, keyword)) return label;
    }
    return null;
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
        // Fara timeout, un Cinemeta blocat tinea pe loc 3 din cele 4 surse (toate
        // asteapta meta-ul) — si, prin Promise.allSettled, tot raspunsul catre Stremio.
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${baseId}.json`, { timeout: 8000 });
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

    // Promisiunea (nu rezultatul) e memorata: cele 3 surse o cer in paralel, iar
    // varianta veche (if (!meta) ...) pornea cate o cerere Cinemeta pt. fiecare.
    let metaPromise = null;
    const getMetaOnce = () => metaPromise || (metaPromise = getCinemetaInfo(args.id, args.type));

    const [rlResult, titrariResult, subnoiResult, subsroResult] = await Promise.allSettled([
        searchRegieLive(args.id, args.type, videoFilename, getMetaOnce),
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
    // Titluri de serial in care scorer-ul n-a gasit niciun sezon/episod — un
    // singur log per cerere, ca formatele noi de pe site-uri sa poata fi
    // stranse din log-urile Render (cauta "[FORMAT-NECUNOSCUT]").
    const unknownFormat = [];

    // Anul/titlul din Cinemeta (sigure) — pt. bonusul de an si pt. excluderea
    // filmelor cu acelasi nume din alt an (vezi ctx in lib/scorer.js).
    const meta = await getMetaOnce();
    const knownYear = meta ? (parseInt(String(meta.year || meta.releaseInfo || '').substring(0, 4), 10) || null) : null;
    const titleName = meta ? meta.name : null;

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

            const { score, breakdown } = calculateScore(sub.title, videoFilenameLower, signal, videoFamily, knownSeason, knownEpisode, videoFamilyIsGuess, {
                contentType: args.type,
                knownYear,
                titleName,
                // doar sursele care cauta dupa TEXT pot intoarce alt film cu acelasi nume
                checkYear: name === 'regielive' || name === 'subtitrarinoi'
            });
            // Titlul mentioneaza explicit un ALT sezon decat cel cerut — nu e risc de
            // sincronizare, e continut garantat gresit. Eliminam complet, nu doar
            // penalizam (vezi lib/scorer.js unde se seteaza acest flag). La fel
            // pentru un episod explicit diferit din acelasi sezon (wrongEpisode).
            if (breakdown.wrongSeason || breakdown.wrongEpisode) continue;
            // Film cu acelasi nume din alt an / episod de serial la cererea unui film.
            if (breakdown.wrongYear || breakdown.wrongType) {
                console.log(`[FILTRU] Exclus [${name}] "${sub.title}" — ${breakdown.wrongYear || breakdown.wrongType}`);
                continue;
            }
            if (args.type === 'series' && /^fara info/.test(breakdown.seEpisode || '')) {
                // Titlu = doar numele serialului (+ an), ca "Supernatural (2005)" de pe
                // Subtitrari-noi — nu e un format, pur si simplu nu are informatia.
                // Punctuatia e scoasa din ambele parti inainte de comparatie: numele
                // din Cinemeta "The Walking Dead: Dead City" apare pe site ca
                // "The Walking Dead  Dead City  2023".
                const words = (x) => ` ${String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
                const rest = (titleName ? words(sub.title).split(words(titleName)).join(' ') : words(sub.title))
                    .replace(/(?<![0-9])(19|20)\d{2}(?![0-9])/g, ' ').replace(/[^a-z0-9]+/g, '');
                if (rest.length > 3) unknownFormat.push(`[${name}] ${sub.title}`);
            }
            const cleanTitle = decodeHtml(sub.title || name);
            const qualityLabel = detectQualityLabel(sub.title, subFamily) || sourceLabel(name);

            const seParam = (knownSeason && knownEpisode) ? `&season=${knownSeason}&episode=${knownEpisode}` : '';
            allScored.push({
                // Protocolul Stremio nu impune niciun format lui "id" ("could be any
                // string") si nu-l foloseste la descarcarea efectiva (asta face "url"-ul
                // de mai jos) — deci putem baga in el eticheta de calitate fara niciun
                // risc. Stremio nu afiseaza oricum acest camp (confirmat: arata doar
                // numele addon-ului), dar Nuvio il afiseaza direct sub limba, deci acolo
                // devine vizibil exact tipul sursei (BluRay/BDRip/WEB-DL/etc).
                id: `${qualityLabel.replace(/\s+/g, '-')}-${name}-${sub.id}`,
                // Trimitem si filename-ul (vf) + sezon/episod cunoscut, ca server.js sa
                // aleaga fisierul corect din arhiva chiar daca vf e un placeholder opac
                url: `${APP_URL}/download.vtt?url=${encodeURIComponent(downloadUrl)}&source=${name}&cookie=${encodeURIComponent(sub.cookie || '')}&vf=${encodeURIComponent(videoFilename)}${seParam}`,
                lang: 'ron',
                title: `${qualityLabel} | ${cleanTitle}`,
                // "label" e documentat oficial in modelul de subtitrare al Nuvio
                // (id/url/lang/label — vezi deepwiki.com/tapframe/NuvioTV/6.4-subtitle-system),
                // exact ca "text de afisat sub limba". Stremio nu-l foloseste (aceeasi
                // situatie ca "title" — cerere deschisa, nefinalizata, vezi issue #936),
                // deci ramane invizibil acolo, dar Nuvio ar trebui sa-l arate in locul
                // lui "id" (pe care il foloseam ca ocolis inainte sa gasim campul asta).
                label: `${qualityLabel} · ${sourceLabel(name)}`,
                score,
                breakdown,
                subFamily,
                _source: name
            });
        }
    }

    if (unknownFormat.length > 0) {
        console.log(`[FORMAT-NECUNOSCUT] ${args.id} — ${unknownFormat.length} titluri fara sezon/episod recunoscut: ${unknownFormat.slice(0, 15).map(t => `"${t}"`).join(' ; ')}`);
    }

    // Taietura gresita (EXTENDED/Director's Cut vs video fara tag, sau invers)
    // merge dupa toate variantele cu taietura corecta, indiferent de scor — vezi
    // breakdown.cutMismatch in lib/scorer.js. Sortam asa inca de aici, ca limitele
    // de mai jos (primele 8 etc.) sa pastreze intai variantele corecte.
    const cutTier = (s) => (s.breakdown.cutMismatch ? 1 : 0);
    allScored.sort((a, b) => cutTier(a) - cutTier(b) || b.score - a.score);

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
    // dupa scor ca inainte. EXCEPTIE: cand chiar video-ul e HDTV, subtitrarea HDTV
    // e potrivirea exacta — inainte era impinsa si atunci sub variante WEB/disc.
    const demoteHdtv = videoFamily !== 'hdtv';
    // Ordinea finala: corecte < HDTV < taietura gresita (desincronizare sigura
    // dupa prima scena diferita, mai grav decat un rip TV) — in fiecare grup,
    // dupa scor.
    const tier = (s) => cutTier(s) * 2 + (demoteHdtv && s.subFamily === 'hdtv' ? 1 : 0);
    finalList.sort((a, b) => tier(a) - tier(b) || b.score - a.score);

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
        if (b.version)      parts.push(b.version);
        if (b.cutMismatch)  parts.push('ALTA TAIETURA — la final');
        if (b.signal)       parts.push(b.signal);
        const marker = i === 0 ? '  <-- ALEASA AUTOMAT' : '';
        console.log(`  #${i + 1} [${sub._source}] [scor ${sub.score.toFixed(1)}] [${sub.subFamily || '?'}] "${sub.title}" — ${parts.join(', ') || 'fara potriviri'}${marker}`);
    });

    const subtitles = finalList.map(sub => ({
        id: sub.id,
        url: sub.url,
        lang: sub.lang,
        title: sub.title,
        label: sub.label
    }));

    return { subtitles };
});

module.exports = builder.getInterface();
