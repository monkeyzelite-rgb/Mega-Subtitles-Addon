// lib/subsro.js
require('dotenv').config();

const axios = require('axios');

const BASE_API = 'https://api.subs.ro/v1.0';
const API_KEY  = process.env.SUBSRO_API_KEY || '';

const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache    = new Map();
const activeSearches = new Map();

function getHeaders() {
    return {
        'X-Subs-Api-Key': API_KEY,
        'Accept': 'application/json',
        'User-Agent': 'StremioROSubs/1.0'
    };
}

async function apiGet(path) {
    try {
        const res = await axios.get(`${BASE_API}${path}`, {
            headers: getHeaders(),
            timeout: 10000
        });
        return res.data;
    } catch (err) {
        if (err.response) {
            console.error(`[SUBSRO] HTTP ${err.response.status} la ${path} — ${err.response.data?.message || ''}`);
        } else {
            console.error(`[SUBSRO] Eroare cerere:`, err.message);
        }
        return null;
    }
}

async function searchSubsRo(imdbId, type, meta) {
    if (!API_KEY) {
        console.warn('[SUBSRO] API_KEY lipsa — sarim peste aceasta sursa.');
        return [];
    }

    const cacheKey = `subsro:${type}:${imdbId}`;

    if (activeSearches.has(cacheKey)) {
        console.log(`[SUBSRO][CACHE] Cautare identica in curs.`);
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

        // METODA 1: cautare dupa IMDB id (cu prefix tt)
        console.log(`[SUBSRO] Metoda 1 — IMDB id: ${baseId}`);
        const data1 = await apiGet(`/search/imdbid/${baseId}?language=ro`);

        if (data1) {
            console.log(`[SUBSRO] Raspuns: count=${data1.count || 0}`);
        }

        let rawList = [];
        if (data1 && Array.isArray(data1.items)) {
            rawList = data1.items;
        }

        results = rawList
            .filter(item => {
                const lang = (item.language || '').toLowerCase();
                return lang === 'ro' || lang === 'ron' || lang === 'rum' || !lang;
            })
            .map(item => ({
                id: String(item.id),
                title: item.description || item.title || `SubsRo-${item.id}`,
                url: item.downloadLink || `${BASE_API}/subtitle/${item.id}/download`,
                downloads: 0,
                rating: null,
                lang: 'ron',
                source: 'subsro'
            }));

        console.log(`[SUBSRO] Metoda 1 → ${results.length} rezultate`);

        // METODA 2: fallback dupa titlu
        if (results.length < 2 && meta && meta.name) {
            console.log(`[SUBSRO] Metoda 2 — Titlu: "${meta.name}"`);
            const encodedTitle = encodeURIComponent(meta.name);
            const data2 = await apiGet(`/search/title/${encodedTitle}?language=ro`);

            let rawList2 = [];
            if (data2 && Array.isArray(data2.items)) rawList2 = data2.items;

            const results2 = rawList2
                .filter(item => {
                    const lang = (item.language || '').toLowerCase();
                    return lang === 'ro' || lang === 'ron' || lang === 'rum' || !lang;
                })
                .map(item => ({
                    id: String(item.id),
                    title: item.description || item.title || `SubsRo-${item.id}`,
                    url: item.downloadLink || `${BASE_API}/subtitle/${item.id}/download`,
                    downloads: 0,
                    rating: null,
                    lang: 'ron',
                    source: 'subsro'
                }));

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
