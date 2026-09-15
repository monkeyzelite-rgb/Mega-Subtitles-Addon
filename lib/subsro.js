// lib/subsro.js
require('dotenv').config();

const axios = require('axios');
const cacheDb = require('./cacheStore');
const BoundedCache = require('./boundedCache');

const BASE_API = 'https://api.subs.ro/v1.0';
const API_KEY  = process.env.SUBSRO_API_KEY || '';

const MEM_TTL_MS = 5 * 60 * 1000;
const searchCache    = new BoundedCache({ ttlMs: MEM_TTL_MS, maxEntries: 300 });
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

function mapItems(items) {
    return (items || [])
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

    const cached = searchCache.get(cacheKey);
    if (cached) {
        console.log(`[SUBSRO][CACHE-MEM] Rezultat recent in memorie.`);
        return cached;
    }

    const fromDb = await cacheDb.getSearch(cacheKey);
    if (fromDb) {
        console.log(`[SUBSRO][CACHE-DB] ${fromDb.length} subtitrari din disc.`);
        searchCache.set(cacheKey, fromDb);
        return fromDb;
    }

    const searchPromise = (async () => {
        const baseId = imdbId.split(':')[0];

        let results = [];

        console.log(`[SUBSRO] Metoda 1 — IMDB id: ${baseId}`);
        const data1 = await apiGet(`/search/imdbid/${baseId}?language=ro`);
        if (data1) console.log(`[SUBSRO] Raspuns: count=${data1.count || 0}`);

        results = mapItems(data1 && Array.isArray(data1.items) ? data1.items : []);
        console.log(`[SUBSRO] Metoda 1 → ${results.length} rezultate`);

        if (results.length < 2 && meta && meta.name) {
            console.log(`[SUBSRO] Metoda 2 — Titlu: "${meta.name}"`);
            const encodedTitle = encodeURIComponent(meta.name);
            const data2 = await apiGet(`/search/title/${encodedTitle}?language=ro`);
            const results2 = mapItems(data2 && Array.isArray(data2.items) ? data2.items : []);
            console.log(`[SUBSRO] Metoda 2 → ${results2.length} rezultate`);

            const seenIds = new Set(results.map(r => r.id));
            for (const r of results2) {
                if (!seenIds.has(r.id)) { results.push(r); seenIds.add(r.id); }
            }
        }

        console.log(`[SUBSRO] Total final: ${results.length} subtitrari`);
        return results;
    })();

    activeSearches.set(cacheKey, searchPromise);

    try {
        const result = await searchPromise;
        searchCache.set(cacheKey, result);
        if (result.length > 0) await cacheDb.setSearch(cacheKey, result);
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
