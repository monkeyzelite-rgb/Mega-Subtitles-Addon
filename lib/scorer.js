// lib/scorer.js
const { GROUPS } = require('./groups');

const DISC_SOURCES = ['remux', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'bd', 'uhd', 'uhdbd', 'bdremux', 'hddvd'];
const WEB_SOURCES  = ['web-dl', 'webdl', 'web.dl', 'webrip', 'web-rip', 'amzn', 'nf', 'hmax', 'dsnp', 'web'];
const HDTV_SOURCES = ['hdtv', 'pdtv', 'dsr', 'dsrip', 'tvrip'];
const LOW_SOURCES  = ['dvdrip', 'dvdscr', 'screener', 'cam', 'hdcam', 'ts', 'telesync', 'tc', 'telecine', 'r5', 'hdrip'];

function getSourceType(text) {
    const t = (text || '').toLowerCase();
    if (DISC_SOURCES.some(s => t.includes(s))) return 'disc';
    if (WEB_SOURCES.some(s => t.includes(s)))  return 'web';
    if (HDTV_SOURCES.some(s => t.includes(s))) return 'hdtv';
    if (LOW_SOURCES.some(s => t.includes(s)))  return 'low';
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

    const dashMatches = t.matchAll(/-\s*([a-z0-9][a-z0-9._&-]{1,24})(?=[\s.,;)\]]|$)/g);
    for (const m of dashMatches) {
        const raw = m[1].replace(/\.(mkv|mp4|avi|srt|sub|zip|rar)$/i, '');
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
    { name: 'extended',   re: /\bextended\b|\bext\.?\s?cut\b|\bextinsa?\b/, changesRuntime: true },
    { name: 'directors',  re: /\bdirector'?s?\.?\s?cut\b|\bdircut\b/, changesRuntime: true },
    { name: 'unrated',    re: /\bunrated\b|\buncensored\b|\bnecenzurat[aă]?\b/, changesRuntime: true },
    { name: 'uncut',      re: /\buncut\b/, changesRuntime: true },
    { name: 'final',      re: /\bfinal\.?\s?cut\b/, changesRuntime: true },
    { name: 'ultimate',   re: /\bultimate\.?\s?cut\b|\bultimate\.?\s?edition\b/, changesRuntime: true },
    { name: 'redux',      re: /\bredux\b/, changesRuntime: true },
    { name: 'theatrical', re: /\btheatrical\b|\bcinema\.?\s?cut\b|\bthtr\b/, changesRuntime: true },
    // noi:
    { name: 'workprint',  re: /\bworkprint\b|\bwp\b|\brough\.?\s?cut\b/, changesRuntime: true },
    { name: 'alternate',  re: /\balternate\.?\s?cut\b|\balternate\.?\s?ending\b|\bfinal\s+alternativ\b/, changesRuntime: true },
    { name: 'special',    re: /\bspecial\.?\s?edition\b|\bediti[ae]\s+speciala\b/, changesRuntime: true },
    { name: 'tvcut',      re: /\btv\.?\s?cut\b|\bbroadcast\.?\s?cut\b|\bfestival\.?\s?cut\b/, changesRuntime: true },
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

function calculateScore(subTitle, videoFilenameLower, signal, videoSourceTypeOverride = null) {
    let score = 0;
    const breakdown = {};
    const subTitleLower = (subTitle || '').toLowerCase();

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
        const videoRuntimeVer = videoVersions.find(v => RUNTIME_CHANGING.includes(v));
        const videoIsTheatrical = videoVersions.includes('theatrical');
        const subRuntimeVers = subVersions.filter(v => RUNTIME_CHANGING.includes(v));

        let versionNote = null;

        if (videoRuntimeVer) {
            if (subVersions.includes(videoRuntimeVer)) {
                score += 40;
                versionNote = `${videoRuntimeVer.toUpperCase()} match(+40)`;
            } else if (subVersions.includes('theatrical')) {
                score -= 70;
                versionNote = `VERSIUNE GRESITA (${videoRuntimeVer} vs theatrical)(-70)`;
            } else if (subRuntimeVers.length > 0) {
                score -= 50;
                versionNote = `versiune diferita (${videoRuntimeVer} vs ${subRuntimeVers.join('/')})(-50)`;
            }
        } else if (videoIsTheatrical) {
            if (subVersions.includes('theatrical')) {
                score += 40;
                versionNote = `THEATRICAL match(+40)`;
            } else if (subRuntimeVers.length > 0) {
                score -= 70;
                versionNote = `VERSIUNE GRESITA (theatrical vs ${subRuntimeVers.join('/')})(-70)`;
            }
        } else {
            if (subVersions.length === 0) {
                score += 5;
                versionNote = `ambele fara versiune(+5)`;
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
                    if (videoFilenameLower.includes('remux') && subTitleLower.includes('remux')) sourceScore = 65;
                }
                if (videoType === 'web' &&
                    (videoFilenameLower.includes('web-dl') || videoFilenameLower.includes('webdl')) &&
                    (subTitleLower.includes('web-dl') || subTitleLower.includes('webdl'))) sourceScore = 60;
                sourceMatch = `${videoType}(+${sourceScore})`;
            } else if (
                (videoType === 'disc' && (subType === 'web' || subType === 'hdtv')) ||
                ((videoType === 'web' || videoType === 'hdtv') && subType === 'disc')
            ) {
                sourceScore = -45;
                sourceMatch = `MISMATCH ${videoType}/${subType}(-45)`;
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

        // 6. SEZON + EPISOD
        const seMatch = videoFilenameLower.match(/s(\d{1,2})e(\d{1,2})/i) ||
                        videoFilenameLower.match(/(\d{1,2})x(\d{1,2})/i);
        if (seMatch) {
            const season  = seMatch[1].padStart(2, '0');
            const episode = seMatch[2].padStart(2, '0');
            const subHasFull   = subTitleLower.includes(`s${season}e${episode}`) ||
                                 subTitleLower.includes(`${parseInt(season)}x${parseInt(episode)}`);
            const subHasSeason = subTitleLower.includes(`s${season}`) ||
                                 subTitleLower.includes(`season ${parseInt(season)}`) ||
                                 subTitleLower.includes(`sezonul ${parseInt(season)}`);
            if (subHasFull) {
                score += 80;
                breakdown.seEpisode = `S${season}E${episode}(+80)`;
            } else if (subHasSeason) {
                score += 40;
                breakdown.seEpisode = `S${season}(+40)`;
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

module.exports = { calculateScore, getSourceType, detectFramerate, detectVersions };
