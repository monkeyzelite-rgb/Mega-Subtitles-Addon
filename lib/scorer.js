// lib/scorer.js
const { GROUPS } = require('./groups');

const DISC_SOURCES = ['remux', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'bd', 'uhd', 'uhdbd', 'bdremux', 'hddvd'];
// Subset de mai sus care sunt rip-uri NEALTERATE de pe Blu-ray (nu transcodari
// comprimate ca BDRip/BRRip) — folosit doar pt. un bonus suplimentar de scor
// cand ambele (video + subtitrare) sunt explicit din acest nivel "premium",
// NU ca o familie separata (raman toate in "disc", ca sa nu riscam sa tratam
// un BDRip ca "familie diferita" de un Remux — sincronizeaza la fel de bine,
// fiind de pe acelasi disc, sursa doar informeaza departajarea).
const DISC_PREMIUM_SOURCES = ['remux', 'bdremux', 'bluray', 'blu-ray', 'uhd', 'uhdbd'];
const WEB_SOURCES  = ['web-dl', 'webdl', 'web.dl', 'webrip', 'web-rip', 'amzn', 'nf', 'hmax', 'dsnp', 'web'];
const HDTV_SOURCES = ['hdtv', 'pdtv', 'dsr', 'dsrip', 'tvrip'];
const LOW_SOURCES  = ['dvdrip', 'dvdscr', 'dvdscreener', 'screener', 'cam', 'camrip', 'hdcam', 'ts', 'tsrip', 'hd-ts', 'telesync', 'tc', 'hd-tc', 'telecine', 'r5', 'hdrip'];

// Cuvintele-cheie se potrivesc pe TOKEN, nu ca substring. Varianta veche
// (t.includes(s)) gasea "ts" in "Ghosts"/"Secrets"/"DTS", "tc" in "Watchmen"/
// "Witcher", "cam" in "Cameron"/romanescul "cam", "nf" in "Inferno"/"Infinity",
// "bd" in "Abduction" — iar cum addon.js elimina complet orice subtitrare
// clasificata "low", candidati perfect valizi dispareau din lista doar din
// cauza titlului filmului. "-"/"." din interiorul unui cuvant-cheie accepta
// orice separator (sau niciunul: "web-dl" prinde si "WEB.DL"/"WEBDL"), iar un
// "rip" lipit la final e tolerat ("HDTVRip", "CAMRip", "WEB-DLRip"), la fel ca o
// rezolutie lipita inainte sau dupa ("BluRay1080p", "720pWEB-DL").
//
// "ts"/"tc"/"cam" sunt prea scurte si prea comune in text obisnuit (romanescul
// "cam", "TS" ca initiale) — le acceptam doar lipite de un separator de tip
// release (".TS.", "-CAM", "HD-TS"), nu intre spatii ca un cuvant din proza.
const AMBIGUOUS_KEYWORDS = new Set(['ts', 'tc', 'cam']);
const keywordRegexCache = new Map();

function keywordRegex(keyword) {
    let re = keywordRegexCache.get(keyword);
    if (re) return re;
    const body = keyword.split(/[-.]/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-. ]?');
    const end = '(?=rip(?![a-z0-9])|[^a-z0-9]|$)';
    const res = '\\d{3,4}[pi]';
    re = AMBIGUOUS_KEYWORDS.has(keyword)
        ? new RegExp(`(?<=[._\\-\\[(])${body}${end}|(?<![a-z0-9])${body}(?=[._\\-\\])])`)
        : new RegExp(`(?:(?<![a-z0-9])|(?<=(?<![a-z0-9])${res}))${body}(?=rip(?![a-z0-9])|${res}(?![a-z0-9])|[^a-z0-9]|$)`);
    keywordRegexCache.set(keyword, re);
    return re;
}

function hasKeyword(text, keyword) {
    return keywordRegex(keyword).test((text || '').toLowerCase());
}

function isDiscPremium(text) {
    return DISC_PREMIUM_SOURCES.some(s => hasKeyword(text, s));
}

function getSourceType(text) {
    const t = (text || '').toLowerCase();
    if (DISC_SOURCES.some(s => hasKeyword(t, s))) return 'disc';
    if (WEB_SOURCES.some(s => hasKeyword(t, s)))  return 'web';
    if (HDTV_SOURCES.some(s => hasKeyword(t, s))) return 'hdtv';
    if (LOW_SOURCES.some(s => hasKeyword(t, s)))  return 'low';
    return null;
}

function detectFramerate(text) {
    const t = (text || '').toLowerCase();
    if (/23[.,]97[68]?|\b2397\b|\b23976\b/.test(t)) return 23.976;
    if (/29[.,]97|\b2997\b/.test(t)) return 29.97;
    if (/59[.,]94/.test(t)) return 59.94;
    if (/\b25\s*fps\b|\b25fps\b|\bpal\b/.test(t)) return 25;
    if (/\b24\s*fps\b|\b24fps\b/.test(t)) return 24;
    if (/\b30\s*fps\b|\b30fps\b/.test(t)) return 30;
    if (/\b50\s*fps\b|\b50fps\b/.test(t)) return 50;
    if (/\b60\s*fps\b|\b60fps\b/.test(t)) return 60;
    if (/\bntsc\b/.test(t)) return 29.97;
    return null;
}

function areFrameratesCompatible(fps1, fps2) {
    if (!fps1 || !fps2) return true;
    if (fps1 === fps2) return true;
    const p = [fps1, fps2].sort((a, b) => a - b);
    if (p[0] === 23.976 && p[1] === 24) return true;
    if (p[0] === 29.97 && p[1] === 30) return true;
    if (p[0] === 59.94 && p[1] === 60) return true;
    return false;
}

// === EXTRAGERE RELEASE GROUP ===
const NOT_GROUPS = new Set([
    '2160p', '1080p', '720p', '480p', '4k', '8k', '1080i', '576p', '2160', '1080', '720',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1', 'xvid', 'divx', '10bit', '8bit',
    'dts', 'ac3', 'aac', 'dd', 'ddp', 'truehd', 'atmos', 'flac', 'mp3', 'eac3', 'dtshd',
    'hd', 'ma', 'es', 'ex', 'dd5', 'ddp5', 'dts-hd', 'dts-x', 'dtsx',
    'bluray', 'blu', 'ray', 'blu-ray', 'bdrip', 'brrip', 'remux', 'webrip', 'web-dl', 'webdl',
    'web', 'dl', 'rip', 'hdtv', 'dvdrip', 'dvdscr', 'hdrip', 'uhd', 'bd', 'hddvd', 'hdts',
    'ts', 'tc', 'dvd', 'dvdr', 'ultrahd', 'bdremux',
    'extended', 'theatrical', 'unrated', 'uncut', 'redux', 'repack', 'proper', 'internal',
    'remastered', 'directors', 'final', 'cut', 'ultimate', 'limited', 'hybrid', 'edition',
    'workprint', 'alternate', 'special', 'imax', 'criterion', 'broadcast', 'festival',
    'hdr', 'hdr10', 'dv', 'dovi', 'sdr', 'multi', 'dual', 'subs', 'sub', 'ro', 'en', 'ita', 'eng',
    'complete', 'season', 'part', 'cd1', 'cd2', 'mkv', 'mp4', 'avi', 'srt', 'fps',
    'sincro', 'sincronizare', 'pentru', 'varianta', 'variantele', 'versiunea', 'versiunile'
]);

const TRAILING_SUFFIXES = new Set(['ro', 'rom', 'ron', 'en', 'eng', 'sub', 'subs', 'srt', 'hi', 'sdh', 'forced']);

function isValidGroupToken(token) {
    if (!token || token.length < 2) return false;
    if (/^\d+$/.test(token)) return false;
    if (/^[\d.]+$/.test(token)) return false;
    if (NOT_GROUPS.has(token)) return false;
    return true;
}

function extractReleaseGroups(text) {
    const t = (text || '').toLowerCase();
    const found = new Set();

    // Tag-urile reale de scena sunt lipite de dash, fara spatii ("x264-GROUP"),
    // spre deosebire de separatorul "Titlu Serial - Titlu Episod" (spatii pe ambele parti)
    // — si sunt mereu ULTIMUL asemenea segment, chiar inainte de extensie. Ne uitam
    // doar la ultima potrivire, ca sa nu confundam un titlu de episod/serial legat
    // coincidental printr-un dash lipit undeva la mijloc cu un nume de grup real.
    // fara "-" in clasa capturata, ca fiecare segment dintre dash-uri sa fie izolat
    // curat (altfel "DTS-HD...-TRiToN" s-ar putea topi intr-un singur token murdar)
    // Lookahead-ul accepta si "[", "(" si "-" dupa grup: "x264-SPARKS[rarbg].mkv"
    // sau "x264-SPARKS-RO" nu mai pierd grupul real (inainte nu se potrivea deloc).
    const dashMatches = [...t.matchAll(/(?<!\s)-(?!\s)([a-z0-9][a-z0-9._&]{1,24})(?=[\s.,;)\]\[(-]|$)/g)];
    let lastIdx = dashMatches.length - 1;
    // Un sufix de limba/subtitrare lipit dupa grup ("-SPARKS-RO", "-GRP-eng")
    // nu e el insusi grupul — sarim doar peste acestea (maxim 2), nu peste orice
    // token invalid, ca "Spider-Man.2002.WEB-DL" sa nu ajunga sa ia "man.2002".
    for (let skipped = 0; lastIdx > 0 && skipped < 2 && TRAILING_SUFFIXES.has(dashMatches[lastIdx][1].replace(/\.(mkv|mp4|avi|srt|sub|zip|rar)$/i, '')); skipped++) {
        lastIdx--;
    }
    const lastDash = dashMatches[lastIdx];
    if (lastDash) {
        const raw = lastDash[1].replace(/\.(mkv|mp4|avi|srt|sub|zip|rar)$/i, '');
        if (isValidGroupToken(raw)) found.add(raw);
        const firstPart = raw.split(/[._-]/)[0];
        if (isValidGroupToken(firstPart)) found.add(firstPart);
    }

    const bracketMatches = t.matchAll(/\[([a-z0-9][a-z0-9._&-]{1,24})\]/g);
    for (const m of bracketMatches) {
        if (isValidGroupToken(m[1])) found.add(m[1]);
        const firstPart = m[1].split(/[._-]/)[0];
        if (isValidGroupToken(firstPart)) found.add(firstPart);
    }

    return found;
}

function findMatchingGroup(videoText, subText) {
    const videoGroups = extractReleaseGroups(videoText);
    const subGroups   = extractReleaseGroups(subText);

    if (videoGroups.size === 0 || subGroups.size === 0) return null;

    for (const g of videoGroups) {
        if (subGroups.has(g)) {
            if (GROUPS.includes(g)) return g;
            if (g.length >= 5) return g;
        }
    }
    return null;
}

// === VERSIUNEA FILMULUI ===
// RUNTIME_CHANGING = schimba durata/scenele filmului -> penalizare mare la mismatch
// VISUAL_ONLY = schimba doar aspectul (culoare, aspect ratio) -> doar informativ, fara penalizare
const VERSION_PATTERNS = [
    // --- Runtime-changing (schimba durata filmului) ---
    { name: 'extended',   re: /\bextended\b|\bext\.?\s?cut\b|\bext\.?\s?edition\b|\bextinsa?\b/, changesRuntime: true },
    // [.\-]dc\b (nu \bdc\b liber) — "DC" ca prescurtare de Director's Cut apare in
    // taguri de scena mereu lipit de un separator ("Japan-DC", "1080p.DC.BluRay"),
    // niciodata cu spatiu inainte ca intr-un titlu normal ("DC Comics", "Washington
    // DC"). Recunoscand doar forma lipita, evitam sa marcam gresit filme cu "DC" in
    // titlu/franciza ca fiind Director's Cut.
    { name: 'directors',  re: /\bdirector'?s?\.?\s?cut\b|\bdircut\b|[.\-]dc\b/, changesRuntime: true },
    { name: 'unrated',    re: /\bunrated\b|\buncensored\b|\bnecenzurat[aă]?\b/, changesRuntime: true },
    { name: 'uncut',      re: /\buncut\b/, changesRuntime: true },
    { name: 'final',      re: /\bfinal\.?\s?cut\b/, changesRuntime: true },
    { name: 'ultimate',   re: /\bultimate\.?\s?cut\b|\bultimate\.?\s?edition\b/, changesRuntime: true },
    { name: 'redux',      re: /\bredux\b/, changesRuntime: true },
    { name: 'theatrical', re: /\btheatrical\b|\bcinema\.?\s?cut\b|\bthtr\b/, changesRuntime: true },
    // noi:
    { name: 'workprint',  re: /\bworkprint\b|\bwp\b|\brough\.?\s?cut\b/, changesRuntime: true },
    { name: 'alternate',  re: /\balternate\.?\s?cut\b|\balternate\.?\s?ending\b|\balt\.?\s?cut\b|\balt\.?\s?ending\b|\bfinal\s+alternativ\b/, changesRuntime: true },
    { name: 'special',    re: /\bspecial\.?\s?edition\b|\bediti[ae]\s+speciala\b|\bspec\.?\s?ed(ition)?\b/, changesRuntime: true },
    { name: 'tvcut',      re: /\btv\.?\s?cut\b|\btelevision\.?\s?cut\b|\bbroadcast\.?\s?cut\b|\bfestival\.?\s?cut\b/, changesRuntime: true },
    { name: 'assembly',   re: /\bassembly\.?\s?cut\b/, changesRuntime: true },
    { name: 'producers',  re: /\bproducer'?s?\.?\s?cut\b/, changesRuntime: true },
    { name: 'completecut',re: /\bcomplete\.?\s?cut\b/, changesRuntime: true },
    // Doar formele complete (nu INTL/INT/EURO/JPN/JAP prescurtate) — prescurtarile
    // se ciocnesc des cu taguri de audio/limba pe exact tipul asta de site-uri
    // ("INTL subs", "JPN dub"), fara nicio legatura cu o editie/taiere diferita.
    { name: 'regional',   re: /\binternational\.?\s?cut\b|\beuropean\.?\s?cut\b|\bjapanese\.?\s?cut\b|\buk\.?\s?cut\b|\bairline\.?\s?cut\b|\binflight\b/, changesRuntime: true },
    // --- Doar vizual (nu schimba durata, doar informativ) ---
    { name: 'imax',       re: /\bimax\.?\s?cut\b|\bimax\.?\s?edition\b/, changesRuntime: false },
    { name: 'criterion',  re: /\bcriterion\b/, changesRuntime: false },
];

function detectVersions(text) {
    const t = (text || '').toLowerCase();
    const found = [];
    for (const v of VERSION_PATTERNS) {
        if (v.re.test(t)) found.push(v.name);
    }
    return found;
}

const RUNTIME_CHANGING = VERSION_PATTERNS.filter(v => v.changesRuntime).map(v => v.name);

// === REFERINTE EXPLICITE LA EPISOD / INTERVALE DE SEZOANE ===
// Intoarce [{ season, from, to }] pentru orice episod numit explicit IMPREUNA cu
// sezonul lui: "S01E05", "S1E5", "S01.E05", "S01E05E06", "S01E01-E10",
// "S01E01-S01E10", "S01E01-10", "1x05", "01x05-06", "sezonul 1 episodul 5",
// "season 1 episodes 1-10". Un episod fara sezon ("Episodul 1071") e ignorat
// intentionat — la anime numerotarea absoluta difera de cea pe sezon din
// Cinemeta si am respinge gresit subtitrari corecte.
function makeRange(season, from, to) {
    // Un "interval" invers, trans-sezon sau absurd de mare (ex. "S01E05 - 2019")
    // nu e un interval real de episoade — il tratam ca episod singular.
    if (to == null || to <= from || to - from > 100) to = from;
    return { season, from, to };
}

function parseEpisodeRefs(text) {
    const t = (text || '').toLowerCase();
    const refs = [];

    // Episoadele suplimentare ("E05E06", "E05.E06", "E01, E02", "E01 si E02") NU
    // accepta "-" ca separator: "-E10" e capatul unui interval ("S01E01-E10").
    const sxe = /(?<![a-z0-9])s(\d{1,2})[\s._-]?e(\d{1,4})((?:(?:\s*[,&+]\s*|\s(?:si|și|and)\s|[\s._])?e\d{1,4})*)(?:\s*-\s*(?:s(\d{1,2}))?e?(\d{1,4})(?![\dpi]))?/g;
    for (const m of t.matchAll(sxe)) {
        const season = parseInt(m[1], 10);
        const first = parseInt(m[2], 10);
        const extra = [...(m[3] || '').matchAll(/e(\d{1,4})/g)].map(x => parseInt(x[1], 10));
        const rangeSeason = m[4] ? parseInt(m[4], 10) : season;
        const rangeEnd = m[5] && rangeSeason === season ? parseInt(m[5], 10) : null;
        if (extra.length > 0) {
            // "S01E05E06" — fisier dublu-episod, fiecare episod e o potrivire exacta
            for (const ep of [first, ...extra]) refs.push({ season, from: ep, to: ep });
        } else {
            refs.push(makeRange(season, first, rangeEnd));
        }
    }

    // "1x05" — (?<!\d\.) exclude "5.1x264" (audio 5.1 lipit de codec), iar
    // 264/265 ca "episod" e aproape sigur tot un codec.
    const nxm = /(?<![a-z0-9])(?<!\d\.)(\d{1,2})x(\d{1,3})(?:\s*-\s*(?:\d{1,2}x)?(\d{1,3}))?(?![\dpi])/g;
    for (const m of t.matchAll(nxm)) {
        const ep = parseInt(m[2], 10);
        if (ep === 264 || ep === 265) continue;
        refs.push(makeRange(parseInt(m[1], 10), ep, m[3] ? parseInt(m[3], 10) : null));
    }

    // "sezonul 2 episoadele 1, 2, 5-8 si 10" — toata lista, nu doar primul numar
    // (altfel un pachet care CONTINE episodul cerut era exclus ca "alt episod").
    const words = /(?:sezonul|season)[\s._-]*0?(\d{1,2})[\s._,:-]*(?:episodul|episoadele|episodes?|ep\.?)[\s._-]*(\d{1,4}(?:\s*-\s*\d{1,4})?(?:(?:\s*[,&+]\s*|\s(?:si|și|and)\s)\d{1,4}(?:\s*-\s*\d{1,4})?)*)/g;
    for (const m of t.matchAll(words)) {
        const season = parseInt(m[1], 10);
        for (const item of m[2].split(/\s*[,&+]\s*|\s(?:si|și|and)\s/)) {
            const [a, b] = item.split('-').map(x => parseInt(x, 10));
            if (!isNaN(a)) refs.push(makeRange(season, a, isNaN(b) ? null : b));
        }
    }

    return refs;
}

const PACK_HINT_RE = /\b(?:complet[ae]?|complete|integral[aă]?|pachet|pack|toate episoadele|all episodes)\b/;

// Intervale de sezoane: "S01-S05", "Seasons 1-5", "Sezoanele 1 - 3", "Sezonul 1-3".
function parseSeasonRanges(text) {
    const t = (text || '').toLowerCase();
    const ranges = [];
    const patterns = [
        /(?<![a-z0-9])s(\d{1,2})\s*-\s*s(\d{1,2})(?![\de])/g,
        /(?:seasons?|sezoanele|sezoane|sezonul)[\s._-]*(\d{1,2})\s*(?:-|–|pana la|to)\s*(\d{1,2})(?!\d)(?!\s*(?:ep|episod))/g
    ];
    for (const re of patterns) {
        for (const m of t.matchAll(re)) {
            const from = parseInt(m[1], 10), to = parseInt(m[2], 10);
            if (to > from && to - from <= 30) ranges.push({ from, to });
        }
    }
    return ranges;
}

function calculateScore(subTitle, videoFilenameLower, signal, videoSourceTypeOverride = null, knownSeason = null, knownEpisode = null, videoSourceTypeIsGuess = false) {
    let score = 0;
    const breakdown = {};
    const subTitleLower = (subTitle || '').toLowerCase();

    // 6. SEZON + EPISOD — calculat MEREU, indiferent daca avem filename, pentru ca
    // knownSeason/knownEpisode vin dintr-o sursa complet separata (ID-ul din
    // catalogul Stremio), nu din filename. Bug confirmat: cand Stremio cere
    // subtitrari fara filename (se intampla des pe iOS, mai ales la schimbarea
    // manuala a subtitrarii in timpul playback-ului), tot blocul de mai jos era
    // ingropat in "if (videoFilenameLower)" de mai jos si sarit COMPLET — inclusiv
    // excluderea pentru sezon gresit — lasand pachete dintr-un sezon cu totul
    // diferit sa castige nestingherite (validate tehnic, dar din episodul gresit,
    // deci Stremio le incarca fara eroare, insa nu se potrivesc cu nimic).
    // Granite explicite — altfel "1920x1080" dintr-un filename de film era citit
    // ca "sezonul 20, episodul 10".
    const seMatch = videoFilenameLower.match(/(?<![a-z0-9])s(\d{1,2})[\s._-]?e(\d{1,4})/i) ||
                    videoFilenameLower.match(/(?<![a-z0-9])(?<!\d\.)(\d{1,2})x(\d{1,3})(?!\d)/i);
    const seasonNum  = knownSeason  || (seMatch ? parseInt(seMatch[1]) : null);
    const episodeNum = knownEpisode || (seMatch ? parseInt(seMatch[2]) : null);
    if (seasonNum && episodeNum) {
        const season  = String(seasonNum).padStart(2, '0');
        const episode = String(episodeNum).padStart(2, '0');
        // Toate episoadele numite explicit pentru sezonul cerut. Daca titlul
        // numeste episoade din ACEST sezon, dar niciunul nu e cel cerut (ex.
        // "S01E02" cand vrem S01E05), e continut garantat gresit — inainte primea
        // chiar +40 ("sezon potrivit"), pentru ca regex-ul de sezon gasea "s01" in
        // "s01e02". Titrari.ro/Subs.ro cauta dupa IMDb-ul serialului si intorc
        // TOATE episoadele, deci cazul e frecvent, nu teoretic.
        const refsForSeason = parseEpisodeRefs(subTitleLower).filter(r => r.season === seasonNum);
        const coveringRefs  = refsForSeason.filter(r => episodeNum >= r.from && episodeNum <= r.to);
        // Episod singur (sau dublu-episod "E05E06"/"E05-E06") = potrivire exacta;
        // un interval mai lung ("E01-E10") = pachet care CONTINE episodul.
        const exactHit = coveringRefs.some(r => r.to - r.from <= 1);
        const packHit  = coveringRefs.length > 0 && !exactHit;
        // (?!\d) = granita de cuvant dupa numar, ca "sezonul 1" sa nu se potriveasca in "sezonul 13"/"sezonul 100"
        // 0? = accepta si formatul fara zero padding (S1E16 pe langa S01E16)
        const subHasFull   = exactHit || (!packHit && (
                             new RegExp(`s0?${seasonNum}e0?${episodeNum}(?!\\d)`, 'i').test(subTitleLower) ||
                             new RegExp(`\\b0?${seasonNum}x0?${episodeNum}(?!\\d)`).test(subTitleLower)));
        const seasonRanges = parseSeasonRanges(subTitleLower);
        const inSeasonRange = seasonRanges.some(r => seasonNum >= r.from && seasonNum <= r.to);
        // [\s._-]* (nu doar \s) intre cuvant si numar — accepta si "Sezonul.03",
        // "Season_3" sau "Sezonul3" fara spatiu, la fel ca separatorul deja folosit
        // in server.js pentru acelasi tip de verificare. 0? = accepta si sezonul
        // scris cu zero in fata ("Sezonul 03" pt. sezonul 3) — fara asta, o
        // subtitrare CORECTA numai pentru ca e zero-padded cadea in ramura "alt
        // sezon" de mai jos (care accepta orice numar) si era exclusa total.
        const subHasSeason = new RegExp(`s0?${seasonNum}(?!\\d)`, 'i').test(subTitleLower) ||
                             new RegExp(`season[\\s._-]*0?${seasonNum}(?!\\d)`, 'i').test(subTitleLower) ||
                             new RegExp(`sezonul[\\s._-]*0?${seasonNum}(?!\\d)`, 'i').test(subTitleLower);
        if (subHasFull) {
            score += 80;
            breakdown.seEpisode = `S${season}E${episode}(+80)`;
        } else if (packHit) {
            const r = coveringRefs[0];
            score += 40;
            breakdown.seEpisode = `S${season} pachet E${String(r.from).padStart(2, '0')}-E${String(r.to).padStart(2, '0')}(+40)`;
        } else if (refsForSeason.length > 0 && !PACK_HINT_RE.test(subTitleLower)) {
            // Aceeasi logica ca la "alt sezon" mai jos: continut garantat gresit,
            // exclus complet din lista (vezi addon.js), nu doar penalizat. Supapa
            // PACK_HINT_RE: un titlu care se declara pachet ("complet", "toate
            // episoadele") nu e exclus doar pt. ca numeste si un episod anume —
            // cade pe logica de sezon de mai jos, iar server.js refuza oricum
            // arhiva daca nu gaseste in ea fisierul episodului cerut.
            score -= 120;
            breakdown.seEpisode = `alt episod (nu S${season}E${episode}) — exclus(-120)`;
            breakdown.wrongEpisode = true;
        } else if (subHasSeason || inSeasonRange) {
            // Un pachet care acopera multe sezoane deodata (serie completa) e mai
            // riscant decat un sezon curat: adesea arhive imbricate (.rar in .rar,
            // cate una per sezon) pe care extractorul nu le poate deschide, si oricum
            // e o potrivire mai putin precisa decat un hit exact pe episod — nu merita
            // acelasi bonus ca un sezon dedicat.
            const seasonTokens = new Set(subTitleLower.match(/\bs\d{1,2}\b/g) || []);
            // inSeasonRange: "Seasons 1-5"/"S01-S05" pt. sezonul 3 — inainte, fara
            // sezonul scris literal, cadea in ramura "alt sezon" si era EXCLUS,
            // desi pachetul il contine (iar server.js stie sa aleaga arhiva
            // imbricata a sezonului corect).
            const isMultiSeasonPack = seasonTokens.size >= 3 || inSeasonRange ||
                /sezoanele\s*\d+\s*-\s*\d+/.test(subTitleLower) ||
                /seasons?\s*\d+\s*-\s*\d+/.test(subTitleLower);
            if (isMultiSeasonPack) {
                score -= 20;
                breakdown.seEpisode = `S${season} in pachet multi-sezon(-20)`;
            } else {
                score += 40;
                breakdown.seEpisode = `S${season}(+40)`;
            }
        } else {
            // Nu contine sezonul cerut — dar daca mentioneaza explicit ALT sezon
            // (ex: "Supernatural.S09...", sau romaneste "Sezonul 13") nu e doar
            // "fara info", e clar sezonul gresit si trebuie penalizat, nu doar
            // ignorat. Fara asta, un pachet de-un-sezon-diferit poate castiga
            // oricum din descarcari+sursa, doar pentru ca "tace" in loc sa fie
            // respins explicit.
            // Acelasi separator flexibil [\s._-]* ca mai sus (nu \s+ obligatoriu) —
            // altfel "Sezonul4" (fara spatiu, alt sezon decat cel cerut) nu era
            // recunoscut nici aici, cadea in ramura "fara info" si putea castiga
            // nemeritat in loc sa fie exclus ca sezon confirmat gresit.
            const otherSeasons = [
                ...(subTitleLower.match(/\bs\d{1,2}(?!\d)/gi) || []),
                ...(subTitleLower.match(/\bsezonul[\s._-]*\d{1,2}(?!\d)/gi) || []),
                ...(subTitleLower.match(/\bseasons?[\s._-]*\d{1,2}(?!\d)/gi) || [])
            ];
            if (otherSeasons.length > 0) {
                // Nu e doar un risc de sincronizare (ca "low" sau "hdtv") — e continut
                // GARANTAT gresit (alt episod, alta poveste). Niciun bonus tehnic (sursa,
                // rezolutie, descarcari) nu ar trebui sa poata scoate asta la suprafata,
                // asa ca marcam explicit pentru excludere totala din lista, nu doar
                // penalizare — vezi addon.js, unde breakdown.wrongSeason opreste
                // candidatul sa mai ajunga la Stremio deloc.
                score -= 120;
                breakdown.seEpisode = `alt sezon (nu S${season}) — exclus(-120)`;
                breakdown.wrongSeason = true;
            } else {
                // Nicio urma de sezon/episod ÎN NICIUN FEL in titlu — nu doar "alt
                // sezon", ci absenta totala a oricarui indiciu. Cautam un episod de
                // serial, deci un candidat "tacut" e suspect: poate fi un titlu
                // generic care se potriveste din greseala cu un cu totul alt
                // continut (confirmat: cautare pt. serialul "The Bear" (2022) a
                // castigat cu un rezultat despre filmul francez "The Bear"/"L'Ours"
                // (1988) — text fara niciun SxxExx, dar cu destule puncte din
                // disc+rezolutie+descarcari cat sa depaseasca variantele corecte).
                // Penalizare moderata, nu la fel de mare ca "alt sezon confirmat",
                // ca sa nu respingem titluri simple care intamplator nu repeta
                // sezonul/episodul dar sunt totusi corecte.
                score -= 25;
                breakdown.seEpisode = `fara info sezon/episod(-25)`;
            }
        }
    }

    if (videoFilenameLower) {
        const videoType = videoSourceTypeOverride || getSourceType(videoFilenameLower);
        const subType   = getSourceType(subTitleLower);
        const sourceTypeMismatch = !!(videoType && subType && videoType !== subType);

        // 1. MATCH SUPREM (+100, redus la +20 daca sursele nu se potrivesc —
        // acelasi grup de release poate re-encoda din surse diferite, nu garanteaza sync-ul)
        const matchedGroup = findMatchingGroup(videoFilenameLower, subTitleLower);
        if (matchedGroup) {
            if (sourceTypeMismatch) {
                score += 20;
                breakdown.matchedGroup = `${matchedGroup}(+20, sursa diferita ${videoType}vs${subType})`;
            } else {
                score += 100;
                breakdown.matchedGroup = `${matchedGroup}(+100)`;
            }
        }

        // 2. FRAMERATE
        const videoFps = detectFramerate(videoFilenameLower);
        const subFps   = detectFramerate(subTitleLower);
        if (videoFps && subFps) {
            if (areFrameratesCompatible(videoFps, subFps)) {
                score += 25;
                breakdown.framerate = `${videoFps}fps match(+25)`;
            } else {
                score -= 40;
                breakdown.framerate = `FPS MISMATCH ${videoFps}vs${subFps}(-40)`;
            }
        } else if (subFps === 25 && !videoFps) {
            score -= 10;
            breakdown.framerate = `sub 25fps PAL(-10)`;
        }

        // 3. VERSIUNEA FILMULUI
        const videoVersions = detectVersions(videoFilenameLower);
        const subVersions   = detectVersions(subTitleLower);
        // Toate versiunile video, nu doar prima gasita — "Directors.Cut.Unrated"
        // vs o subtitrare "Unrated" e aceeasi versiune, nu "versiune diferita".
        // ("theatrical" e si el in RUNTIME_CHANGING, deci vechea ramura separata
        // "else if (videoIsTheatrical)" nu era atinsa niciodata: theatrical vs
        // extended primea -50 in loc de -70-ul intentionat.)
        const videoRuntimeVers = videoVersions.filter(v => RUNTIME_CHANGING.includes(v));
        const subRuntimeVers = subVersions.filter(v => RUNTIME_CHANGING.includes(v));

        let versionNote = null;

        if (videoRuntimeVers.length > 0) {
            const commonVer = videoRuntimeVers.find(v => subRuntimeVers.includes(v));
            const videoLabel = videoRuntimeVers.join('/');
            if (commonVer) {
                score += 40;
                versionNote = `${commonVer.toUpperCase()} match(+40)`;
            } else if (subRuntimeVers.length > 0 && (subRuntimeVers.includes('theatrical') || videoRuntimeVers.includes('theatrical'))) {
                score -= 70;
                versionNote = `VERSIUNE GRESITA (${videoLabel} vs ${subRuntimeVers.join('/')})(-70)`;
            } else if (subRuntimeVers.length > 0) {
                score -= 50;
                versionNote = `versiune diferita (${videoLabel} vs ${subRuntimeVers.join('/')})(-50)`;
            }
        } else {
            // Video fara niciun tag de versiune = aproape sigur varianta de cinema
            // (conventia de scena: doar editiile NON-standard sunt etichetate).
            // Inainte, o subtitrare "EXTENDED"/"Director's Cut" pierdea doar cei
            // +5 de mai jos — un rating RegieLive mai bun o scotea usor pe primul
            // loc, desi scenele in plus o desincronizeaza dupa prima diferenta.
            const subNonTheatrical = subRuntimeVers.filter(v => v !== 'theatrical');
            if (subNonTheatrical.length > 0) {
                score -= 30;
                versionNote = `sub ${subNonTheatrical.join('/')}, video fara versiune(-30)`;
            } else if (subVersions.length === 0 || subRuntimeVers.length > 0) {
                score += 5;
                versionNote = subVersions.length === 0 ? `ambele fara versiune(+5)` : `THEATRICAL, video fara versiune(+5)`;
            }
        }

        // Info suplimentar (fara scor) pentru tag-uri doar vizuale — util in log
        const videoVisualOnly = videoVersions.filter(v => !RUNTIME_CHANGING.includes(v));
        if (videoVisualOnly.length > 0) {
            const label = videoVisualOnly.join('/').toUpperCase();
            versionNote = versionNote ? `${versionNote}, ${label}(info)` : `${label}(info)`;
        }

        // 4. SURSA
        let sourceScore = 0;
        let sourceMatch = null;

        if (videoType && subType) {
            if (videoType === subType) {
                sourceScore = 55;
                if (videoType === 'disc') {
                    sourceScore = 60;
                    if (videoFilenameLower.includes('remux') && subTitleLower.includes('remux')) {
                        sourceScore = 65;
                    } else if (isDiscPremium(videoFilenameLower) && isDiscPremium(subTitleLower)) {
                        // Video E BluRay/Remux/UHD si subtitrarea e explicit din
                        // aceeasi clasa (nu doar BDRip/BRRip) — nu schimba sincronizarea
                        // (ambele raman aceeasi familie "disc"), dar la departajare
                        // finala (de obicei dupa descarcari) nu vrem ca un BDRip mai
                        // popular sa iasa mereu peste un BluRay etichetat corect.
                        sourceScore = 63;
                    }
                }
                if (videoType === 'web' &&
                    hasKeyword(videoFilenameLower, 'web-dl') && hasKeyword(subTitleLower, 'web-dl')) sourceScore = 60;
                sourceMatch = `${videoType}(+${sourceScore})`;
            } else if (
                (videoType === 'disc' && (subType === 'web' || subType === 'hdtv')) ||
                ((videoType === 'web' || videoType === 'hdtv') && subType === 'disc')
            ) {
                // Cand familia video vine dintr-o GHICIRE dupa marimea fisierului (nu
                // din numele lui), NU aplicam penalizarea — confirmat pe productie
                // (One Piece, episoade de 24 min): pragurile de marime pentru "disc"
                // sunt calibrate pt. filme/episoade lungi, iar un episod scurt cu
                // bitrate mare (WEB de calitate) trece usor pragul si e ghicit gresit
                // ca "disc". O ghicire nesigura nu ar trebui sa penalizeze o
                // potrivire altfel corecta — poate doar sa NU dea bonus (mai jos, la
                // branch-ul de match exact, bonusul tot se aplica normal).
                if (videoSourceTypeIsGuess) {
                    sourceScore = 0;
                    sourceMatch = `familie ghicita dupa marime, ignor mismatch (${videoType}vs${subType})`;
                } else {
                    sourceScore = -45;
                    sourceMatch = `MISMATCH ${videoType}/${subType}(-45)`;
                }
            } else {
                sourceScore = -15;
                sourceMatch = `mismatch(${videoType}vs${subType})(-15)`;
            }
        } else if (videoType && !subType) {
            sourceScore = -10;
            sourceMatch = `sub fara sursa(-10)`;
        }
        score += sourceScore;

        if (versionNote) {
            sourceMatch = sourceMatch ? `${sourceMatch}, ${versionNote}` : versionNote;
        }
        if (sourceMatch) breakdown.sourceMatch = sourceMatch;

        // 5. REZOLUTIE (+20)
        for (const res of ['2160p', '1080p', '720p', '480p']) {
            if (videoFilenameLower.includes(res) && subTitleLower.includes(res)) {
                score += 20;
                breakdown.resMatch = `${res}(+20)`;
                break;
            }
        }

        // 7. ANUL (+30)
        const yearMatch = videoFilenameLower.match(/\b(19|20)\d{2}\b/);
        if (yearMatch && subTitleLower.includes(yearMatch[0])) {
            score += 30;
            breakdown.year = `${yearMatch[0]}(+30)`;
        }

        // 8. CODEC (+15)
        for (const codec of ['x265', 'hevc', 'x264', 'h264', 'av1']) {
            if (videoFilenameLower.includes(codec) && subTitleLower.includes(codec)) {
                score += 15;
                breakdown.codec = `${codec}(+15)`;
                break;
            }
        }

        // 9. SOFT TOKEN OVERLAP
        if (score < 50) {
            const videoTokens = videoFilenameLower.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 2);
            let common = 0;
            for (const token of videoTokens) {
                if (subTitleLower.includes(token)) common++;
            }
            if (common >= 3) {
                const softBonus = Math.min(common * 5, 25);
                score += softBonus;
                breakdown.softMatch = `${common} tokene comune(+${softBonus})`;
            }
        }
    }

    // 10. DEPARTAJARE FINALA
    if (signal && signal.type === 'rating') {
        const r = parseFloat(signal.value) || 0;
        score += r;
        breakdown.signal = `rating:${r}`;
    } else if (signal && signal.type === 'downloads') {
        const d = Math.log10((signal.value || 0) + 1);
        score += d;
        breakdown.signal = `downloads:${signal.value}→+${d.toFixed(2)}`;
    }

    return { score, breakdown };
}

module.exports = { calculateScore, getSourceType, detectFramerate, detectVersions, hasKeyword, parseEpisodeRefs, parseSeasonRanges };
