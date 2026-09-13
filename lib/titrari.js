// lib/titrari.js
const axios = require('axios');
const cheerio = require('cheerio');
const cacheDb = require('./cache');

const BASE_URL = 'https://www.titrari.ro';
const MEM_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map();
const activeSearches = new Map();

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Referer': BASE_URL
};

async function fetchSearchPage(params) {
    try {
        const response = await axios.get(`${BASE_URL}/index.php`, {
            params: { page: 'cautamainaltaparte', z8: '1', ...params },
            headers: HEADERS,
            timeout: 10000
        });
        return response.data;
    } catch (err) {
        console.error(`[TITRARI] Eroare cerere:`, err.message);
        return null;
    }
}

function parseResults(html) {
    if (!html) return [];

    const results = [];
    const seenIds = new Set();

    const blockRegex = /get\.php\?id=(\d+)[\s\S]*?Descarcari:\s*(\d+)[\s\S]*?Comentariu.*?<\/b><\/td><td[^>]*>([\s\S]*?)<\/td>/g;
    let match;

    while ((match = blockRegex.exec(html)) !== null) {
        const subId = match[1];
        if (seenIds.has(subId)) continue;
        seenIds.add(subId);

        const downloads = parseInt(match[2]) || 0;
        const rawTitle = match[3].replace(/<[^>]+>/g, '').trim();
        const title = rawTitle || `Titrari-${subId}`;

        results.push({
            id: subId,
            title,
            url: `${BASE_URL}/get.php?id=${subId}`,
            downloads,
            lang: 'ron',
            source: 'titrari'
        });
    }

    if (results.length === 0) {
        const idRegex = /get\.php\?id=(\d+)/g;
        let idMatch;
        while ((idMatch = idRegex.exec(html)) !== null) {
            const subId = idMatch[1];
            if (seenIds.has(subId)) continue;
            seenIds.add(subId);
            results.push({
                id: subId,
                title: `Titrari-${subId}`,
                url: `${BASE_URL}/get.php?id=${subId}`,
                downloads: 0,
                lang: 'ron',
                source: 'titrari'
            });
        }
    }

    return results;
}

async function searchTitrari(imdbId, type, meta) {
    const cacheKey = `titrari:${type}:${imdbId}`;

    if (activeSearches.has(cacheKey)) {
        console.log(`[TITRARI][CACHE] Cautare identica in curs, reutilizez.`);
        return activeSearches.get(cacheKey);
    }

    // 1. Cache in memorie
    const now = Date.now();
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        console.log(`[TITRARI][CACHE-MEM] Rezultat recent in memorie.`);
        return cached.data;
    }

    // 2. Cache pe disc (SQLite) — supravietuieste repornirii
    const fromDb = cacheDb.getSearch(cacheKey);
    if (fromDb) {
        console.log(`[TITRARI][CACHE-DB] ${fromDb.length} subtitrari din disc.`);
        searchCache.set(cacheKey, { data: fromDb, expiresAt: now + MEM_TTL_MS });
        return fromDb;
    }

    const searchPromise = (async () => {
        const cleanImdbId = imdbId.split(':')[0];
        const imdbNum = cleanImdbId.replace(/^tt/i, '');

        let results = [];

        console.log(`[TITRARI] Metoda 1 — IMDB id: tt${imdbNum}`);
        const html1 = await fetchSearchPage({ z5: imdbNum });
        results = parseResults(html1);
        console.log(`[TITRARI] Metoda 1 → ${results.length} rezultate`);
        if (results.length > 0) {
            console.log(`[TITRARI] Primul rezultat: "${results[0].title}" (${results[0].downloads} descarcari)`);
        }

        if (results.length < 3 && meta && meta.name) {
            console.log(`[TITRARI] Metoda 2 — Titlu+An: "${meta.name}"`);
            const params2 = { z2: meta.name };
            if (meta.year) params2.z7 = String(meta.year).substring(0, 4);
            const html2 = await fetchSearchPage(params2);
            const results2 = parseResults(html2);
            console.log(`[TITRARI] Metoda 2 → ${results2.length} rezultate`);

            const seenIds = new Set(results.map(r => r.id));
            for (const r of results2) {
                if (!seenIds.has(r.id)) { results.push(r); seenIds.add(r.id); }
            }
        }

        if (results.length < 3 && meta && meta.name) {
            console.log(`[TITRARI] Metoda 3 — Doar titlu: "${meta.name}"`);
            const html3 = await fetchSearchPage({ z2: meta.name });
            const results3 = parseResults(html3);
            console.log(`[TITRARI] Metoda 3 → ${results3.length} rezultate`);

            const seenIds = new Set(results.map(r => r.id));
            for (const r of results3) {
                if (!seenIds.has(r.id)) { results.push(r); seenIds.add(r.id); }
            }
        }

        console.log(`[TITRARI] Total final: ${results.length} subtitrari`);
        return results;
    })();

    activeSearches.set(cacheKey, searchPromise);

    try {
        const result = await searchPromise;
        searchCache.set(cacheKey, { data: result, expiresAt: Date.now() + MEM_TTL_MS });
        // Salvam doar rezultate nevide — nu are sens sa cache-uim esecuri 7 zile
        if (result.length > 0) cacheDb.setSearch(cacheKey, result);
        return result;
    } finally {
        activeSearches.delete(cacheKey);
    }
}

function clearTitrariCache() {
    const count = searchCache.size;
    searchCache.clear();
    activeSearches.clear();
    return count;
}

module.exports = { searchTitrari, clearTitrariCache };
