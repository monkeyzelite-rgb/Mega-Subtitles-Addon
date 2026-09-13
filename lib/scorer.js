// lib/scorer.js

const GROUPS = ['0mnidvd', '0tv', '1920', '20ripz', '2hd', '2pacaveli', '3ctweb', '3l', '433', '4fr', '4hm', '4kbec', '4khd', '7sins', 'a4o', 'aaf', 'aas', 'abbie', 'abd', 'abez', 'acclaim', 'aced', 'adhd', 'admirals', 'adrenaline', 'adweb', 'ae', 'aegis', 'aek', 'aen', 'aeroholics', 'afo', 'aggr0', 'airforce', 'airline', 'airwaves', 'aisha', 'ajp69', 'aldi', 'alliance', 'amber', 'ambitious', 'amiable', 'amrap', 'amstel', 'anarchy', 'anbc', 'angelic', 'anihls', 'anivcd', 'ao', 'aoc', 'apex', 'apl', 'aqua', 'archivist', 'argon', 'ariestv', 'arigold', 'arisco', 'ariscrapaysites', 'arrow', 'artemix', 'arthouse', 'asap', 'asister', 'atelier', 'aterfallet', 'atotik', 'ats', 'av1svasi', 'avcdvd', 'avchd', 'avs', 'avs720', 'aw', 'awake', 'azninvasion', 'azurray', 'b3yg1r', 'bae', 'bajskorv', 'baked', 'bamhd', 'bass', 'bbq', 'bdisc', 'beesknees', 'ben.the.men', 'bfm', 'bhdstudio', 'bia', 'bigdoc', 'bioma', 'bitor', 'bizkit', 'blaze', 'bloom', 'bluetv', 'bluranium', 'blutonium', 'bmdru', 'bmf', 'bob', 'bone', 'bravery', 'brg', 'bs', 'btbn', 'btm', 'btn', 'btsd', 'btw', 'burcyg', 'byndr', 'c0ke', 'caffeine', 'cakes', 'cansiz', 'casstudio', 'cbfm', 'cdd', 'cddhd', 'cebex', 'cg1989', 'chakra', 'chara', 'chd', 'chdsubs', 'chdweb', 'chortle', 'chotab', 'chronicles', 'cia', 'cinefeel', 'cinefile', 'cinefox', 'cinemaniacs', 'cinematic', 'cinemix', 'cinephiles', 'cit', 'classic', 'cmrg', 'coalition', 'coaster', 'codswallop', 'cojonudo', 'compulsion', 'coo7', 'cookiemonster', 'counterfeit', 'cpt', 'cpy', 'cravers', 'crfw', 'crimson', 'crisc', 'critter2376', 'crow', 'crud', 'ct', 'ctrlhd', 'ctrlsd', 'ctu', 'd-z0n3', 'd3g', 'dariush', 'darksaber', 'dawn', 'db', 'deadbadugly', 'decibel', 'deep', 'deflate', 'deimos', 'dermagic', 'deuterium', 'dh', 'digger', 'dimension', 'dirt', 'dkv', 'don', 'dracula', 'drm1', 'dunghill', 'dust', 'ea', 'ebp', 'eclipse', 'edge2020', 'edhd', 'edith', 'edph', 'egen', 'elite', 'encounters', 'end', 'endeavour', 'epsilon', 'erix', 'ethel', 'ethics', 'evolve', 'exploit', 'eztv', 'factory', 'family', 'fc', 'felix', 'fenix', 'fever', 'fgt', 'flame', 'flhd', 'flights', 'florix', 'flux', 'forbidden', 'fov', 'fqm', 'framestor', 'fts', 'futv', 'fw', 'galaxytv', 'gang', 'gardai', 'geckos', 'geek', 'ggez', 'ghd', 'ghost', 'ghouls', 'glhf', 'gnome', 'gnomission', 'goki', 'gossip', 'gprs', 'grace', 'haggis', 'hallowed', 'hawes', 'hdchina', 'hddt', 'hdex', 'hdmi', 'hdsky', 'hdtime', 'herkz', 'heteam', 'hhweb', 'hidt', 'hifi', 'hightimes', 'hiqve', 'hisd', 'hodl', 'hone', 'hqmux', 'huzzah', 'ift', 'ijp', 'ika', 'ime', 'immerse', 'inchy', 'infinity', 'inflate', 'inspirit', 'it00nz', 'ivy', 'jamtarts', 'jatt', 'jbee', 'jenkins', 'jetix', 'jmess', 'joebee', 'jr', 'kamikaze', 'khn', 'killers', 'kimchi', 'kimji', 'kingturd', 'kings', 'kitsune', 'kogi', 'kontrast', 'kralimarko', 'kratos', 'kyogo', 'lazy', 'lazers', 'legi0n', 'linkle', 'lion', 'littleblueman', 'loki', 'lol', 'lolhd', 'lootera', 'lord', 'lostfilm', 'lunar', 'madsky', 'magicstar', 'mainframe', 'mama', 'mch', 'meech', 'megusta', 'mercator', 'mesc', 'mhysa', 'midweek', 'miu', 'mjolnir', 'mnkyddl', 'monkee', 'mortyrick', 'mrhulk', 'mrn', 'mteam', 'mv', 'mzabi', 'n1h4l', 'nailedit', 'naisu', 'ncmt', 'neonoir', 'newman', 'ngr', 'nhtfs', 'nikt0', 'nima4k', 'ninjacentral', 'nitsua', 'nogroup', 'nogrp', 'noma', 'nortekst', 'nosivid', 'noxxus', 'npms', 'ntb', 'ntg', 'nyh', 'o69', 'oft', 'onlyfaffs', 'orbitron', 'ouija', 'ourbits', 'oxidizer', 'panda', 'pawel2006', 'paxa', 'pexa', 'pfa', 'phocis', 'phoenix', 'pi', 'pieguy', 'pike', 'pitbull', 'playbd', 'playhd', 'playweb', 'plutonium', 'pmhd', 'pmp', 'pof', 'poiasd', 'poppers', 'poppycock', 'pow4hd', 'pragma', 'primefix', 'prodji', 'psa', 'psig', 'pter', 'ptg', 'ptp', 'qash', 'qfg', 'qman', 'qoq', 'quintessence', 'qxr', 'r&h', 'r0cked', 'ralphy', 'rapta', 'rarbg', 'rawr', 'rcsw', 'rcvr', 'regedits', 'regret', 'revils', 'reward', 'river', 'rng', 'roccat', 'rogue', 'rovers', 'rtfm', 'rtn', 'rumour', 's14', 'sa89', 'sadpanda', 'saints', 'sampa', 'saphire', 'sbr', 'sdcc', 'sector7', 'seedpool', 'seriously', 'sexsh0p', 'sfm', 'shieldbearer', 'shieldearer', 'shortbrehd', 'sic', 'sicfoi', 'sighthd', 'sigma', 'silence', 'siluhd', 'sinners', 'siq', 'sitv', 'skizoid', 'skyfire', 'slignome', 'slm', 'sloth', 'smd', 'smurf', 'sow', 'sparks', 'sphd', 'spid3r', 'spirit', 'squalor', 'stc', 'strife', 'strontium', 'successfulcrab', 'sumvision', 'sunspot', 'surfinbird', 'svd', 'swaglander', 'swtyblz', 'sys', 't00ng0d', 't4h', 't6d', 'tabularia', 'taoe', 'tayto', 'tbn', 'tbs', 'tcm', 'tdd', 'telly', 'tepes', 'terra', 'tgx', 'thefarm', 'thelastofus', 'thewretched', 'thx', 'tikos', 'timelords', 'tizu', 'tjupt', 'tl', 'tlf', 'tn', 'tnp', 'toa', 'tommy', 'tovar', 'triton', 'trollhd', 'tsint', 'ttg', 'tva', 'tvr', 'tvsmash', 'twaseries', 'twisted', 'tx', 'ultimatex264', 'umd', 'umf', 'underbelly', 'universum', 'unveil', 'useless', 'utr', 'varyg', 'vcdvault', 'vd0n', 'velvet', 'vialle', 'viethd', 'vietnam', 'vision', 'visum', 'voa', 'w0rm', 'w4f', 'w4nk3r', 'wadu', 'walmart', 'wankaz', 'wdym', 'webdv', 'welp', 'whatelse', 'whiskeyjack', 'whoised', 'wide', 'wiki', 'wildcat', 'wire', 'woke', 'wpi', 'wusiwug', 'xebec', 'xepa', 'xlf', 'xor', 'xtm', 'xxx4u', 'yassmiso', 'yawnix', 'ycdv', 'yello', 'yellowbird', 'yestv', 'yify', 'youforgottorepackthis', 'yts', 'zero00', 'zerotwo', 'zmnt', 'zorosenpai', 'zq', 'zzgtv'];

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

// === DETECTIE FRAMERATE ===
// Framerate diferit = subtitrare desincronizata garantat
// 23.976 (film/BluRay), 25 (PAL/Europa), 29.97 (NTSC/TV US), 24, 30, 50, 60
function detectFramerate(text) {
    const t = (text || '').toLowerCase();

    // Patterns comune in filename-uri si descrieri de subtitrari
    // 23.976, 23,976, 23.98, 2397, 23976
    if (/23[.,]97[68]?|\b2397\b|\b23976\b/.test(t)) return 23.976;
    // 29.97, 29,97, 2997
    if (/29[.,]97|\b2997\b/.test(t)) return 29.97;
    // 59.94
    if (/59[.,]94/.test(t)) return 59.94;
    // 25 fps / 25fps / PAL
    if (/\b25\s*fps\b|\b25fps\b|\bpal\b/.test(t)) return 25;
    // 24 fps
    if (/\b24\s*fps\b|\b24fps\b/.test(t)) return 24;
    // 30 fps
    if (/\b30\s*fps\b|\b30fps\b/.test(t)) return 30;
    // 50 fps
    if (/\b50\s*fps\b|\b50fps\b/.test(t)) return 50;
    // 60 fps
    if (/\b60\s*fps\b|\b60fps\b/.test(t)) return 60;
    // NTSC implica 29.97
    if (/\bntsc\b/.test(t)) return 29.97;

    return null;
}

// Framerate-uri compatibile intre ele (nu necesita resincronizare)
function areFrameratesCompatible(fps1, fps2) {
    if (!fps1 || !fps2) return true; // necunoscut — nu penalizam
    if (fps1 === fps2) return true;

    // 23.976 si 24 sunt practic identice (diferenta 0.1%)
    const pair = [fps1, fps2].sort((a, b) => a - b);
    if (pair[0] === 23.976 && pair[1] === 24) return true;
    if (pair[0] === 29.97 && pair[1] === 30) return true;
    if (pair[0] === 59.94 && pair[1] === 60) return true;

    return false;
}

/**
 * @param {string} subTitle
 * @param {string} videoFilenameLower
 * @param {{ type: 'rating'|'downloads'|'none', value: number }} signal
 * @param {string|null} videoSourceTypeOverride
 */
function calculateScore(subTitle, videoFilenameLower, signal, videoSourceTypeOverride = null) {
    let score = 0;
    const breakdown = {};
    const subTitleLower = (subTitle || '').toLowerCase();

    if (videoFilenameLower) {
        // 1. MATCH SUPREM (+100) — release group exact
        for (const g of GROUPS) {
            const regex = new RegExp(`\\b${g}\\b`, 'i');
            if (regex.test(videoFilenameLower) && regex.test(subTitleLower)) {
                score += 100;
                breakdown.matchedGroup = `${g}(+100)`;
                break;
            }
        }

        // 2. FRAMERATE — critic pentru sincronizare
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
        } else if (subFps && !videoFps) {
            // Subtitrarea specifica un framerate dar video-ul nu
            // Daca e 25fps (PAL), e probabil pentru DVD european — risc
            if (subFps === 25) {
                score -= 10;
                breakdown.framerate = `sub 25fps PAL, video necunoscut(-10)`;
            }
        }

        // 3. SURSA — cu penalizare mismatch
        const videoType = videoSourceTypeOverride || getSourceType(videoFilenameLower);
        const subType   = getSourceType(subTitleLower);

        let sourceScore = 0;
        let sourceMatch = null;

        if (videoType && subType) {
            if (videoType === subType) {
                sourceScore = 55;
                if (videoType === 'disc') {
                    sourceScore = 60;
                    if (videoFilenameLower.includes('remux') && subTitleLower.includes('remux')) {
                        sourceScore = 65;
                    }
                }
                if (videoType === 'web' &&
                    (videoFilenameLower.includes('web-dl') || videoFilenameLower.includes('webdl')) &&
                    (subTitleLower.includes('web-dl') || subTitleLower.includes('webdl'))) {
                    sourceScore = 60;
                }
                sourceMatch = `${videoType}(+${sourceScore})`;
            } else {
                if ((videoType === 'disc' && subType === 'web') ||
                    (videoType === 'web'  && subType === 'disc')) {
                    sourceScore = -45;
                    sourceMatch = `MISMATCH disc/web(-45)`;
                } else {
                    sourceScore = -15;
                    sourceMatch = `mismatch(${videoType}vs${subType})(-15)`;
                }
            }
        } else if (videoType && !subType) {
            sourceScore = -10;
            sourceMatch = `sub fara sursa(-10)`;
        }

        score += sourceScore;
        if (sourceMatch) breakdown.sourceMatch = sourceMatch;

        // 4. REZOLUTIE (+20)
        for (const res of ['2160p', '1080p', '720p', '480p']) {
            if (videoFilenameLower.includes(res) && subTitleLower.includes(res)) {
                score += 20;
                breakdown.resMatch = `${res}(+20)`;
                break;
            }
        }

        // 5. SEZON + EPISOD (+80 complet, +40 doar sezon)
        const seMatch = videoFilenameLower.match(/s(\d{1,2})e(\d{1,2})/i) ||
                        videoFilenameLower.match(/(\d{1,2})x(\d{1,2})/i);
        if (seMatch) {
            const season  = seMatch[1].padStart(2, '0');
            const episode = seMatch[2].padStart(2, '0');
            const subHasFull   = subTitleLower.includes(`s${season}e${episode}`) ||
                                  subTitleLower.includes(`${parseInt(season)}x${parseInt(episode)}`);
            const subHasSeason = subTitleLower.includes(`s${season}`) ||
                                  subTitleLower.includes(`season ${parseInt(season)}`);
            if (subHasFull) {
                score += 80;
                breakdown.seEpisode = `S${season}E${episode}(+80)`;
            } else if (subHasSeason) {
                score += 40;
                breakdown.seEpisode = `S${season}(+40)`;
            }
        }

        // 6. ANUL (+30)
        const yearMatch = videoFilenameLower.match(/\b(19|20)\d{2}\b/);
        if (yearMatch && subTitleLower.includes(yearMatch[0])) {
            score += 30;
            breakdown.year = `${yearMatch[0]}(+30)`;
        }

        // 7. CODEC (+15)
        for (const codec of ['x265', 'hevc', 'x264', 'h264', 'av1']) {
            if (videoFilenameLower.includes(codec) && subTitleLower.includes(codec)) {
                score += 15;
                breakdown.codec = `${codec}(+15)`;
                break;
            }
        }

        // 8. SOFT TOKEN OVERLAP
        if (score < 50) {
            const videoTokens = videoFilenameLower
                .replace(/[^\w\s]/g, ' ')
                .split(/\s+/)
                .filter(t => t.length > 2);
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

    // 9. DEPARTAJARE FINALA
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

module.exports = { calculateScore, getSourceType, detectFramerate };
