// lib/titrari.js
const axios = require('axios');
const cheerio = require('cheerio');
const cacheDb = require('./cacheStore');
const BoundedCache = require('./boundedCache');

const BASE_URL = 'https://www.titrari.ro';
const MEM_TTL_MS = 5 * 60 * 1000;
const searchCache = new BoundedCache({ ttlMs: MEM_TTL_MS, maxEntries: 300 });
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

    // Impartim pagina in segmente, cate unul per rand de subtitrare, folosind
    // "get.php?id=" ca delimitator de rand, si cautam DOAR in interiorul
    // segmentului fiecarui id.
    //
    // Vechiul cod folosea un singur regex global care cauta cuvantul generic
    // "Comentariu" ca ancora de oprire pentru titlu — dar acel cuvant mai apare
    // si in alta parte a paginii (21 aparitii vs 20 randuri reale), asa ca
    // atunci cand un rand nu avea structura exact asteptata, regex-ul sarea
    // peste granita lui si capta titlurile din MAI MULTE randuri urmatoare
    // intr-un singur string concatenat (bug confirmat: un pachet de Sezon 9
    // aparea cu titlul unui cu totul alt pachet lipit dupa el). Delimitarea pe
    // segmente per-id elimina posibilitatea asta din start.
    //
    // In interiorul unui rand, titlul e in AL DOILEA <td class=comment...>
    // (primul e eticheta "Comentariu:" insasi) — verificat direct pe HTML-ul
    // real (exact 2 per rand, consistent pe toata pagina).
    const idPositions = [...html.matchAll(/get\.php\?id=(\d+)/g)].map(m => ({ id: m[1], index: m.index }));

    for (let i = 0; i < idPositions.length; i++) {
        const { id: subId, index } = idPositions[i];
        if (seenIds.has(subId)) continue;
        seenIds.add(subId);

        const segmentEnd = i + 1 < idPositions.length ? idPositions[i + 1].index : html.length;
        const segment = html.slice(index, segmentEnd);

        const downloadsMatch = segment.match(/Descarcari:\s*(\d+)/i);
        const downloads = downloadsMatch ? (parseInt(downloadsMatch[1]) || 0) : 0;

        const commentTds = [...segment.matchAll(/class=comment[^>]*>([\s\S]*?)<\/td>/gi)];
        // Comentariile uploader-ului pot avea mai multe linii (<br>) — un singur
        // rand poate lista mai multe release-uri compatibile + credite traducator.
        // E continut legitim, nu bug de parsare, dar fara spatiu intre linii
        // rezulta text lipit ilizibil ("...ECISupernatural.S09...").
        const rawTitle = commentTds.length >= 2
            ? commentTds[1][1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
            : '';
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
    const cached = searchCache.get(cacheKey);
    if (cached) {
        console.log(`[TITRARI][CACHE-MEM] Rezultat recent in memorie.`);
        return cached;
    }

    // 2. Cache persistent (SQLite local sau Redis pe Vercel) — supravietuieste repornirii
    const fromDb = await cacheDb.getSearch(cacheKey);
    if (fromDb) {
        console.log(`[TITRARI][CACHE-DB] ${fromDb.length} subtitrari din disc.`);
        searchCache.set(cacheKey, fromDb);
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
        searchCache.set(cacheKey, result);
        // Salvam doar rezultate nevide — nu are sens sa cache-uim esecuri 7 zile
        if (result.length > 0) await cacheDb.setSearch(cacheKey, result);
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
