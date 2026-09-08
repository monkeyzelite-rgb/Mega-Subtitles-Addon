// lib/subsro.js
// API Subs.ro v1.0
// Documentatie: https://subs.ro/api
// Endpoint principal: GET https://api.subs.ro/v1.0/search/imdbid/{imdb_id}
// Autentificare: header X-API-Key
// Semnal de calitate: TBD empiric din raspunsul API (rating sau downloads)

const axios = require('axios');

const BASE_API   = 'https://api.subs.ro/v1.0';
const API_KEY    = process.env.SUBSRO_API_KEY || '';

const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache  = new Map();
const activeSearches = new Map();

function getHeaders() {
    return {
        'X-API-Key': API_KEY,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; StremioROSubs/1.0)'
    };
}

// Apel GET catre API-ul Subs.ro
async function apiGet(path) {
    try {
        const res = await axios.get(`${BASE_API}${path}`, {
            headers: getHeaders(),
            timeout: 10000
        });
        return res.data;
    } catch (err) {
        if (err.response) {
            console.error(`[SUBSRO] HTTP ${err.response.status} la ${path}`);
        } else {
            console.error(`[SUBSRO] Eroare cerere:`, err.message);
        }
        return null;
    }
}

// Normalizeaza un rezultat brut din API intr-un obiect uniform
function normalizeResult(item) {
    if (!item) return null;

    // Detectam semnalul de calitate din ce returneaza API-ul
    // Il vom vedea empiric la primul run — logam tot raspunsul brut prima data
    let downloads = 0;
    let rating    = null;

    if (typeof item.downloads === 'number') downloads = item.downloads;
    if (typeof item.download_count === 'number') downloads = item.download_count;
    if (typeof item.rating === 'number') rating = item.rating;
    if (typeof item.score === 'number') rating = item.score;

    // URL de download — incercam campurile comune
    const downloadUrl = item.download_url || item.url || item.link ||
                        (item.id ? `${BASE_API}/download/${item.id}` : null);

    if (!downloadUrl) return null;

    return {
        id: String(item.id || item.subtitle_id || Math.random()),
        title: item.release || item.title || item.name || 'Subs.ro',
        url: downloadUrl,
        downloads,
        rating,
        lang: 'ron',
        source: 'subsro'
    };
}

async function searchSubsRo(imdbId, type, meta) {
    if (!API_KEY) {
        console.warn('[SUBSRO] API_KEY lipsa — sarim peste aceasta sursa.');
        return [];
    }

    const cacheKey = `subsro:${type}:${imdbId}`;

    if (activeSearches.has(cacheKey)) {
        console.log(`[SUBSRO][CACHE] Cautare identica in curs, reutilizez.`);
        return activeSearches.get(cacheKey);
    }

    const now = Date.now();
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        console.log(`[SUBSRO][CACHE] Rezultat recent in cache.`);
        return cached.data;
    }

    const searchPromise = (async () => {
        const baseId = imdbId.split(':')[0]; // scoatem :sezon:episod

        let results = [];

        // METODA 1: cautare dupa IMDB id (endpoint nativ)
        console.log(`[SUBSRO] Metoda 1 — IMDB id: ${baseId}`);
        const data1 = await apiGet(`/search/imdbid/${baseId}`);

        // Logam prima data raspunsul brut ca sa vedem structura exacta
        if (data1) {
            console.log(`[SUBSRO] Raspuns brut (primele 500 chars):`,
                JSON.stringify(data1).substring(0, 500));
        }

        // Extragem lista de subtitrari din raspuns
        // API-ul poate returna: array direct, sau { subtitles: [] }, sau { data: [] }
        let rawList = [];
        if (Array.isArray(data1)) {
            rawList = data1;
        } else if (data1 && Array.isArray(data1.subtitles)) {
            rawList = data1.subtitles;
        } else if (data1 && Array.isArray(data1.data)) {
            rawList = data1.data;
        } else if (data1 && Array.isArray(data1.results)) {
            rawList = data1.results;
        }

        results = rawList
            .map(normalizeResult)
            .filter(Boolean)
            // Filtram doar romana (sau fara limba specificata)
            .filter(r => {
                const lang = (r.lang || '').toLowerCase();
                return !lang || lang === 'ro' || lang === 'ron' || lang === 'romanian';
            });

        console.log(`[SUBSRO] Metoda 1 → ${results.length} rezultate`);

        // METODA 2: fallback dupa titlu, daca IMDB id nu a dat rezultate
        if (results.length < 3 && meta && meta.name) {
            console.log(`[SUBSRO] Metoda 2 — Titlu: "${meta.name}"`);
            const query = encodeURIComponent(meta.name);
            const data2 = await apiGet(`/search/title/${query}`);

            let rawList2 = [];
            if (Array.isArray(data2)) rawList2 = data2;
            else if (data2 && Array.isArray(data2.subtitles)) rawList2 = data2.subtitles;
            else if (data2 && Array.isArray(data2.data)) rawList2 = data2.data;
            else if (data2 && Array.isArray(data2.results)) rawList2 = data2.results;

            const results2 = rawList2
                .map(normalizeResult)
                .filter(Boolean)
                .filter(r => {
                    const lang = (r.lang || '').toLowerCase();
                    return !lang || lang === 'ro' || lang === 'ron' || lang === 'romanian';
                });

            console.log(`[SUBSRO] Metoda 2 → ${results2.length} rezultate`);

            const seenIds = new Set(results.map(r => r.id));
            for (const r of results2) {
                if (!seenIds.has(r.id)) {
                    results.push(r);
                    seenIds.add(r.id);
                }
            }
        }

        console.log(`[SUBSRO] Total final: ${results.length} subtitrari`);
        return results;
    })();

    activeSearches.set(cacheKey, searchPromise);

    try {
        const result = await searchPromise;
        searchCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
        return result;
    } finally {
        activeSearches.delete(cacheKey);
    }
}

function clearSubsRoCache() {
    const count = searchCache.size;
    searchCache.clear();
    activeSearches.clear();
    return count;
}

module.exports = { searchSubsRo, clearSubsRoCache };
