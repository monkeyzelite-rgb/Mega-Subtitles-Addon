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

// === FRAMERATE ===
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

// === VERSIUNEA FILMULUI ===
// Extended vs Theatrical = scene diferite = desincronizare garantata.
// Returneaza TOATE versiunile gasite (o subtitrare poate acoperi mai multe).
const VERSION_PATTERNS = [
    { name: 'extended',   re: /\bextended\b|\bext\.?\s?cut\b|\bextinsa?\b|\bversiunea\s+extinsa\b/ },
    { name: 'directors',  re: /\bdirector'?s?\.?\s?cut\b|\bdirectors\b|\bdircut\b|\bdc\b/ },
    { name: 'unrated',    re: /\bunrated\b|\bnecenzurat[aă]?\b/ },
    { name: 'uncut',      re: /\buncut\b|\bfull\.?cut\b/ },
    { name: 'final',      re: /\bfinal\.?\s?cut\b/ },
    { name: 'ultimate',   re: /\bultimate\.?\s?cut\b|\bultimate\.?\s?edition\b/ },
    { name: 'redux',      re: /\bredux\b/ },
    { name: 'special',    re: /\bspecial\.?\s?edition\b|\bse\.?\s?edition\b/ },
    { name: 'remastered', re: /\bremastered\b|\bremasterizat[aă]?\b/ },
    { name: 'theatrical', re: /\btheatrical\b|\bcinema\.?\s?cut\b|\bvariant[aă]\s+cinema\b/ }
];

// Versiuni care schimba durata filmului (conteaza pentru sincronizare)
const RUNTIME_CHANGING = ['extended', 'directors', 'unrated', 'uncut', 'final', 'ultimate', 'redux', 'special'];

function detectVersions(text) {
    const t = (text || '').toLowerCase();
    const found = [];
    for (const v of VERSION_PATTERNS) {
        if (v.re.test(t)) found.push(v.name);
    }
    return found;
}

function calculateScore(subTitle, videoFilenameLower, signal, videoSourceTypeOverride = null) {
    let score = 0;
    const breakdown = {};
    const subTitleLower = (subTitle || '').toLowerCase();

    if (videoFilenameLower) {
        // 1. MATCH SUPREM (+100)
        for (const g of GROUPS) {
            const regex = new RegExp(`\\b${g}\\b`, 'i');
            if (regex.test(videoFilenameLower) && regex.test(subTitleLower)) {
                score += 100;
                breakdown.matchedGroup = `${g}(+100)`;
                break;
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
        // Versiunea principala a video-ului = prima care schimba durata
        const videoVer = videoVersions.find(v => RUNTIME_CHANGING.includes(v))
                      || (videoVersions.includes('theatrical') ? 'theatrical' : null);
        const subRuntimeVers = subVersions.filter(v => RUNTIME_CHANGING.includes(v));

        let versionNote = null;

        if (videoVer && videoVer !== 'theatrical') {
            if (subVersions.includes(videoVer)) {
                score += 35;
                versionNote = `${videoVer.toUpperCase()} match(+35)`;
            } else if (subRuntimeVers.length > 0) {
                score -= 40;
                versionNote = `VERSIUNE GRESITA (${videoVer} vs ${subRuntimeVers.join('/')})(-40)`;
            } else if (subVersions.includes('theatrical')) {
                score -= 40;
                versionNote = `VERSIUNE GRESITA (${videoVer} vs theatrical)(-40)`;
            } else {
                score -= 5;
                versionNote = `sub fara versiune(-5)`;
            }
        } else {
            // Video e theatrical (explicit sau implicit, fara marcaj)
            if (subVersions.includes('theatrical')) {
                score += 35;
                versionNote = `THEATRICAL match(+35)`;
            } else if (subRuntimeVers.length > 0) {
                score -= 25;
                versionNote = `sub e ${subRuntimeVers.join('/')}, video theatrical(-25)`;
            }
        }

        // 4. SURSA
        const videoType = videoSourceTypeOverride || getSourceType(videoFilenameLower);
        const subType   = getSourceType(subTitleLower);
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
            } else if ((videoType === 'disc' && subType === 'web') || (videoType === 'web' && subType === 'disc')) {
                sourceScore = -45;
                sourceMatch = `MISMATCH disc/web(-45)`;
            } else {
                sourceScore = -15;
                sourceMatch = `mismatch(${videoType}vs${subType})(-15)`;
            }
        } else if (videoType && !subType) {
            sourceScore = -10;
            sourceMatch = `sub fara sursa(-10)`;
        }
        score += sourceScore;

        // Punem versiunea langa sursa ca sa apara in log fara alte modificari
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
