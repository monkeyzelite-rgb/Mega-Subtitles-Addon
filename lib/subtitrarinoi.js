// lib/subtitrarinoi.js
// Scraping Subtitrari-noi.ro
// Cautare: titlu+an → titlu simplu (site-ul nu accepta IMDB id nativ)
// Semnal de calitate: campul "Descarcari:" afisat pe pagina fiecarei subtitrari

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.subtitrari-noi.ro';
const SEARCH_URL = `${BASE_URL}/index.php`;

const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map();
const activeSearches = new Map();

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Referer': BASE_URL
};

async function fetchSearchPage(query) {
    try {
        const response = await axios.get(SEARCH_URL, {
            params: {
                page: 'cautare',
                s: query
            },
            headers: HEADERS,
            timeout: 10000
        });
        return response.data;
    } catch (err) {
        console.error(`[SUBTITRARINOI] Eroare cerere:`, err.message);
        return null;
    }
}

function parseResults(html) {
    if (!html) return [];

    const $ = cheerio.load(html);
    const results = [];
    const seenIds = new Set();

    // Subtitrari-noi.ro listeaza rezultatele ca link-uri catre pagina fiecarei subtitrari
    // Pattern URL: /XXXX-subtitrari-noi.ro-Titlu-Film-YYYY.zip sau similar
    $('a[href]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim();

        if (!text || text.length < 3) return;

        // Identificam link-urile de subtitrari dupa pattern-ul URL-ului lor
        // Doua tipuri posibile:
        // 1. Link direct catre zip: /1234-subtitrari-noi.ro-Titlu.zip
        // 2. Link catre pagina de detalii: /subtitrare/1234/titlu
        const zipMatch  = href.match(/\/(\d+)-subtitrari-noi\.ro-(.+?)\.zip$/i);
        const pageMatch = href.match(/\/subtitrare\/(\d+)\//i) ||
                          href.match(/[?&]id=(\d+)/i);

        let subId = null;
        let downloadUrl = null;

        if (zipMatch) {
            subId = zipMatch[1];
            downloadUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        } else if (pageMatch) {
            subId = pageMatch[1];
            // URL de download construit din id
            downloadUrl = `${BASE_URL}/download.php?id=${subId}`;
        }

        if (!subId || seenIds.has(subId)) return;
        seenIds.add(subId);

        results.push({
            id: subId,
            title: text,
            url: downloadUrl,
            downloads: 0, // completat mai jos daca parsam pagina de detalii
            lang: 'ron',
            source: 'subtitrarinoi'
        });
    });

    return results;
}

// Incercam sa luam numarul de descarcari de pe pagina individuala a subtitrarii
// Apelat doar pentru primele N rezultate ca sa nu facem prea multe cereri
async function enrichWithDownloads(results, maxToEnrich = 10) {
    const toEnrich = results.slice(0, maxToEnrich);

    await Promise.allSettled(toEnrich.map(async (sub) => {
        try {
            // Pagina de detalii a subtitrarii
            const detailUrl = `${BASE_URL}/subtitrare/${sub.id}/`;
            const res = await axios.get(detailUrl, { headers: HEADERS, timeout: 8000 });
            const $ = cheerio.load(res.data);

            // Cautam textul "Descarcari:" sau "Descărcări:" urmat de un numar
            $('*').each((i, el) => {
                const text = $(el).text();
                const dlMatch = text.match(/desc[aă]rc[aă]ri\s*:?\s*(\d+)/i);
                if (dlMatch) {
                    sub.downloads = parseInt(dlMatch[1]);
                    return false; // stop each
                }
            });
        } catch {
            // Daca pagina de detalii nu merge, lasam downloads = 0
        }
    }));

    return results;
}

async function searchSubtitrariNoi(imdbId, type, meta) {
    const cacheKey = `subtitrarinoi:${type}:${imdbId}`;

    if (activeSearches.has(cacheKey)) {
        console.log(`[SUBTITRARINOI][CACHE] Cautare identica in curs, reutilizez.`);
        return activeSearches.get(cacheKey);
    }

    const now = Date.now();
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        console.log(`[SUBTITRARINOI][CACHE] Rezultat recent in cache.`);
        return cached.data;
    }

    const searchPromise = (async () => {
        let results = [];

        // METODA 1: titlu + an (cel mai precis pentru acest site)
        if (meta && meta.name) {
            const query1 = meta.year ? `${meta.name} ${meta.year}` : meta.name;
            console.log(`[SUBTITRARINOI] Metoda 1 — Titlu+An: "${query1}"`);
            const html1 = await fetchSearchPage(query1);
            results = parseResults(html1);
            console.log(`[SUBTITRARINOI] Metoda 1 → ${results.length} rezultate`);
        }

        // METODA 2: doar titlu, daca metoda 1 a dat putine rezultate
        if (results.length < 3 && meta && meta.name) {
            console.log(`[SUBTITRARINOI] Metoda 2 — Doar titlu: "${meta.name}"`);
            const html2 = await fetchSearchPage(meta.name);
            const results2 = parseResults(html2);
            console.log(`[SUBTITRARINOI] Metoda 2 → ${results2.length} rezultate`);

            const seenIds = new Set(results.map(r => r.id));
            for (const r of results2) {
                if (!seenIds.has(r.id)) {
                    results.push(r);
                    seenIds.add(r.id);
                }
            }
        }

        // Imbogatim primele 10 rezultate cu numarul de descarcari
        if (results.length > 0) {
            console.log(`[SUBTITRARINOI] Fetch descarcari pentru primele ${Math.min(results.length, 10)} rezultate...`);
            await enrichWithDownloads(results, 10);
        }

        console.log(`[SUBTITRARINOI] Total final: ${results.length} subtitrari`);
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

function clearSubtitrariNoiCache() {
    const count = searchCache.size;
    searchCache.clear();
    activeSearches.clear();
    return count;
}

module.exports = { searchSubtitrariNoi, clearSubtitrariNoiCache };