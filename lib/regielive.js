const axios = require('axios');
const fuzzball = require('fuzzball');

const API_URL = 'https://api.regielive.ro/bazarr/search.php';
const API_KEY = 'API-BAZARR-YTZ-SL';
const TITLE_MATCH_THRESHOLD = 60; // sub acest scor (0-100), filmul e considerat "alt film" si e ignorat
const MIN_RESULTS_THRESHOLD = 5; // sub cate rezultate incercam si urmatoarea metoda de cautare
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minute

const activeSearches = new Map(); // cereri identice in curs (evita cereri duplicate simultane)
const searchResultCache = new Map(); // rezultate recente (evita sa lovim RegieLive la fiecare refresh de player)

// --- Limitator de conexiuni catre API-ul de cautare RegieLive ---
// Conform indicatiilor primite de la RegieLive: max ~8 cereri/minut (rafala max 2/sec),
// si maxim 1-2 conexiuni SIMULTANE catre API. Asta e diferit de limita de descarcare
// (care e pe volum/reputatie, nu pe viteza) - deci NU atinge cache-ul de download.
const MAX_CONCURRENT_API_CALLS = 2;
const MAX_CALLS_PER_MINUTE = 8;
const MAX_BURST_PER_SECOND = 2;

let activeApiConnections = 0;
const apiCallTimestamps = [];

function canMakeApiCallNow() {
    const now = Date.now();
    while (apiCallTimestamps.length && now - apiCallTimestamps[0] > 60000) {
        apiCallTimestamps.shift();
    }
    const callsInLastSecond = apiCallTimestamps.filter(t => now - t < 1000).length;
    return activeApiConnections < MAX_CONCURRENT_API_CALLS
        && apiCallTimestamps.length < MAX_CALLS_PER_MINUTE
        && callsInLastSecond < MAX_BURST_PER_SECOND;
}

function acquireApiSlot() {
    return new Promise(resolve => {
        const tryAcquire = () => {
            if (canMakeApiCallNow()) {
                activeApiConnections++;
                apiCallTimestamps.push(Date.now());
                resolve();
            } else {
                setTimeout(tryAcquire, 150);
            }
        };
        tryAcquire();
    });
}

function releaseApiSlot() {
    activeApiConnections = Math.max(0, activeApiConnections - 1);
}

async function getCinemetaInfo(imdbId, type) {
    try {
        const baseId = imdbId.split(':')[0];
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${baseId}.json`);
        return res.data.meta;
    } catch (error) {
        console.error("Eroare Cinemeta:", error.message);
        return null;
    }
}

async function fetchFromRegieLive(params) {
    await acquireApiSlot();
    try {
        return await axios.get(API_URL, {
            params: params,
            headers: {
                'RL-API': API_KEY,
                'User-Agent': 'StremioRegieLiveAddon/1.0.0',
                'Referer': 'https://subtitrari.regielive.ro',
                'Accept': 'application/json, text/plain, */*'
            }
        });
    } finally {
        releaseApiSlot();
    }
}

async function searchRegieLive(imdbId, type, videoFilename) {
    const cacheKey = `${type}:${imdbId}`;

    // Daca exista deja o cautare identica in desfasurare (Stremio cere subtitrari
    // de multiple ori aproape simultan pentru acelasi episod), ne agatam de ea in loc
    // sa trimitem alta cerere in paralel catre RegieLive (asta declansa rate-limit-ul
    // lor tacut si dadea rezultate "hit or miss").
    if (activeSearches.has(cacheKey)) {
        console.log(`[CACHE] Căutare identică deja în curs pentru ${cacheKey}, reutilizez rezultatul.`);
        return activeSearches.get(cacheKey);
    }

    const now = Date.now();
    const cached = searchResultCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        console.log(`[CACHE] Rezultat recent în cache pentru ${cacheKey}.`);
        return cached.data;
    }

    const searchPromise = _searchRegieLive(imdbId, type, videoFilename);
    activeSearches.set(cacheKey, searchPromise);

    try {
        const result = await searchPromise;
        searchResultCache.set(cacheKey, { data: result, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
        return result;
    } finally {
        activeSearches.delete(cacheKey);
    }
}

async function _searchRegieLive(imdbId, type, videoFilename) {
    console.log(`\n--- [CĂUTARE NOUĂ] ---`);
    console.log(`[1] Caut pentru ${type} cu ID: ${imdbId}`);

    const cleanImdbId = imdbId.split(':')[0];

    const seenSubIds = new Set(); // dedup pe baza ID-ului subtitrarii (subKey)
    const subtitles = [];
    let sessionCookie = "";
    let meta = null; // info Cinemeta, obtinute lazy, o singura data

    // Extrage rezultatele dintr-un raspuns RegieLive si le adauga in lista finala,
    // sarind peste duplicate si (optional) peste filme care nu se potrivesc cu titlul cautat.
    function ingestResponse(response, { isFallbackByName, referenceTitle }) {
        if (!response) return 0;

        if (response.headers && response.headers['set-cookie']) {
            sessionCookie = response.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        }

        if (!response.data || !response.data.rezultate) return 0;

        const filme = response.data.rezultate;
        let added = 0;
        let firstFilmLogged = false;

        for (const filmKey in filme) {
            const filmObj = filme[filmKey];
            const subs = filmObj.subtitrari;
            if (!subs) continue;

            // Validam identitatea filmului doar cand am cautat dupa nume (fallback),
            // pentru ca acolo RegieLive poate returna filme diferite cu nume asemanator.
            if (isFallbackByName && referenceTitle) {
                let filmTitle = null;
                if (typeof filmObj.film === 'string') {
                    filmTitle = filmObj.film;
                } else if (filmObj.film && typeof filmObj.film === 'object') {
                    filmTitle = filmObj.film.nume || filmObj.film.titlu || filmObj.film.name || filmObj.film.title || null;
                } else {
                    filmTitle = filmObj.nume || filmObj.titlu || filmObj.name || filmObj.title || null;
                }

                if (!firstFilmLogged) {
                    console.log('[DEBUG] Chei disponibile pe obiectul film RegieLive:', Object.keys(filmObj));
                    console.log('[DEBUG] Conținutul câmpului "film":', JSON.stringify(filmObj.film));
                    firstFilmLogged = true;
                }

                if (filmTitle) {
                    const matchScore = fuzzball.ratio(referenceTitle, filmTitle);
                    if (matchScore < TITLE_MATCH_THRESHOLD) {
                        console.log(`[FILTRU TITLU] Ignor "${filmTitle}" (scor ${matchScore} fata de "${referenceTitle}")`);
                        continue;
                    }
                }
                // daca filmTitle e null, nu putem valida -> lasam rezultatul sa treaca
            }

            for (const subKey in subs) {
                if (seenSubIds.has(subKey)) continue; // deja adaugat dintr-o cautare anterioara
                seenSubIds.add(subKey);

                subtitles.push({
                    id: subKey,
                    lang: 'ron',
                    title: subs[subKey].titlu,
                    url: subs[subKey].url,
                    rating: subs[subKey].rating ? subs[subKey].rating.nota : "N/A",
                    cookie: sessionCookie
                });
                added++;
            }
        }
        return added;
    }

    // --- METODA 1: strict dupa ID-ul de IMDb (cea mai precisa) ---
    try {
        const imdbParams = { imdbid: cleanImdbId };
        if (type === 'series') {
            const parts = imdbId.split(':');
            imdbParams.sezon = parts[1];
            imdbParams.episod = parts[2];
        }

        console.log(`[DEBUG API] Încercarea 1 (Strict IMDb ID):`, imdbParams);
        const response = await fetchFromRegieLive(imdbParams);
        ingestResponse(response, { isFallbackByName: false });
    } catch (err) {
        console.log(`[!] Căutarea după IMDb ID nu a returnat rezultate (404 sau eroare). Trecem la planul 2...`);
    }

    // --- METODA 1.5: dupa numele fisierului (recomandarea principala a RegieLive pentru
    // titluri generice/scurte, unde nume+an poate rata - ex: "It" -> ei il au listat ca
    // "It: Part 1 - The Losers' Club"). Nu aplicam filtrul fuzzy aici: match-ul pe numele
    // exact de fisier e deja suficient de precis, iar fuzzy ar respinge gresit exact
    // cazurile astea de retitlu.
    if (subtitles.length < MIN_RESULTS_THRESHOLD && videoFilename) {
        const cleanFilename = videoFilename.replace(/\.[a-z0-9]{2,4}$/i, ''); // scoate extensia
        if (cleanFilename.length >= 3) {
            const fisierParams = { fisier: cleanFilename };
            if (type === 'series') {
                const parts = imdbId.split(':');
                fisierParams.sezon = parts[1];
                fisierParams.episod = parts[2];
            }

            console.log(`[DEBUG API] Încercarea 1.5 (Dupa numele fisierului):`, fisierParams);
            try {
                const response = await fetchFromRegieLive(fisierParams);
                ingestResponse(response, { isFallbackByName: false });
            } catch (errFisier) {
                console.log(`[!] Căutarea după numele fișierului a eșuat (404 sau eroare).`);
            }
        }
    }

    // --- METODA 2: Nume + An, doar daca inca nu avem destule rezultate ---
    if (subtitles.length < MIN_RESULTS_THRESHOLD) {
        meta = await getCinemetaInfo(imdbId, type);
        if (meta) {
            const textParams = {};
            if (type === 'series') {
                const parts = imdbId.split(':');
                textParams.nume = meta.name;
                textParams.sezon = parts[1];
                textParams.episod = parts[2];
            } else {
                textParams.nume = meta.name;
            }

            const rawYear = meta.year || meta.releaseInfo;
            if (rawYear) {
                textParams.an = parseInt(String(rawYear).substring(0, 4), 10);
            }

            console.log(`[DEBUG API] Încercarea 2 (Nume + An de rezervă):`, textParams);
            try {
                const response = await fetchFromRegieLive(textParams);
                ingestResponse(response, { isFallbackByName: true, referenceTitle: meta.name });
            } catch (err2) {
                console.log(`[!] Căutarea Nume+An a eșuat (404 sau eroare). Trecem la planul 3...`);
            }
        }
    }

    // --- METODA 3: doar Nume, tot ca sa completam pana la pragul minim ---
    if (subtitles.length < MIN_RESULTS_THRESHOLD) {
        if (!meta) meta = await getCinemetaInfo(imdbId, type);
        if (meta) {
            const nameOnlyParams = { nume: meta.name };
            if (type === 'series') {
                const parts = imdbId.split(':');
                nameOnlyParams.sezon = parts[1];
                nameOnlyParams.episod = parts[2];
            }

            console.log(`[DEBUG API] Încercarea 3 (Doar Nume curat):`, nameOnlyParams);
            try {
                const response = await fetchFromRegieLive(nameOnlyParams);
                ingestResponse(response, { isFallbackByName: true, referenceTitle: meta.name });
            } catch (err3) {
                console.log(`[OK] Nicio subtitrare suplimentară găsită pe RegieLive pentru acest titlu.`);
            }
        }
    }

    console.log(`[OK] Trimis la Stremio: ${subtitles.length} subtitrări (Sesiune salvată).`);
    return subtitles;
}

function clearSearchCache() {
    const count = searchResultCache.size;
    searchResultCache.clear();
    activeSearches.clear();
    return count;
}

module.exports = { searchRegieLive, clearSearchCache };
