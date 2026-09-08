// lib/titrari.js
// Scraping Titrari.ro
// Cautare: imdb id nativ (param z5) → titlu+an → titlu simplu
// Semnal de calitate: campul "Descarcari:" afisat pe pagina fiecarei subtitrari

const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.titrari.ro';
const SEARCH_URL = `${BASE_URL}/index.php`;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minute, la fel ca RegieLive
const searchCache = new Map();
const activeSearches = new Map();

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Referer': BASE_URL
};

// Trimite o cerere GET catre pagina de cautare avansata a Titrari.ro
// Parametrii acceptati: z2 (titlu), z5 (imdb id fara "tt"), z7 (an)
async function fetchSearchPage(params) {
    try {
        const response = await axios.get(SEARCH_URL, {
            params: { page: 'cautarepreaavansata', ...params },
            headers: HEADERS,
            timeout: 10000
        });
        return response.data;
    } catch (err) {
        // Titrari.ro poate returna 404 cand imdb id-ul nu exista la ei
        // il prindem explicit si returnam null ca fallback-ul sa continue
        if (err.response && err.response.status === 404) {
            console.log(`[TITRARI] 404 pentru params:`, params, `— trecem la urmatoarea metoda`);
            return null;
        }
        console.error(`[TITRARI] Eroare cerere:`, err.message);
        return null;
    }
}

// Parseaza HTML-ul paginii de rezultate si returneaza lista de subtitrari
function parseResults(html) {
    if (!html) return [];

    const $ = cheerio.load(html);
    const results = [];

    // Titrari.ro afiseaza rezultatele intr-un tabel cu clasa "searchResult" sau similar
    // Fiecare rand contine: titlu, link detalii, numar descarcari
    $('table tr').each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length < 2) return;

        // Linkul catre pagina subtitrarii
        const linkEl = $(row).find('a[href*="detalii"]');
        if (!linkEl.length) return;

        const href = linkEl.attr('href');
        const title = linkEl.text().trim();
        if (!title || !href) return;

        // ID-ul subtitrarii din URL (ex: ?page=detalii&id=12345)
        const idMatch = href.match(/id=(\d+)/i);
        if (!idMatch) return;
        const subId = idMatch[1];

        // Numarul de descarcari — cautam celula care contine un numar
        let downloads = 0;
        cells.each((j, cell) => {
            const text = $(cell).text().trim();
            const dlMatch = text.match(/^(\d+)$/);
            if (dlMatch && parseInt(dlMatch[1]) > 0) {
                downloads = parseInt(dlMatch[1]);
            }
        });

        // URL de download direct
        // Titrari.ro: ?page=descarca&id={subId}
        const downloadUrl = `${BASE_URL}/index.php?page=descarca&id=${subId}`;

        results.push({
            id: subId,
            title,
            url: downloadUrl,
            downloads,
            lang: 'ron',
            source: 'titrari'
        });
    });

    return results;
}

async function _searchTitrari(imdbId, type) {
    const cleanImdbId = imdbId.split(':')[0]; // scoatem :sezon:episod daca e serial
    const imdbNum = cleanImdbId.replace(/^tt/i, ''); // scoatem "tt" — titrari vrea doar numarul

    let results = [];

    // METODA 1: dupa imdb id (nativ pe Titrari.ro, param z5)
    console.log(`[TITRARI] Metoda 1 — IMDB id: ${imdbNum}`);
    const html1 = await fetchSearchPage({ z5: imdbNum });
    results = parseResults(html1);
    console.log(`[TITRARI] Metoda 1 → ${results.length} rezultate`);

    // METODA 2: fallback — vom adauga titlu+an din Cinemeta daca metoda 1 da 0 rezultate
    // (implementat in searchTitrari de mai jos, dupa ce avem meta)

    return results;
}

// Functia publica — cu cache si deduplicare cereri simultane (la fel ca in regielive.js)
async function searchTitrari(imdbId, type, meta) {
    const cacheKey = `titrari:${type}:${imdbId}`;

    if (activeSearches.has(cacheKey)) {
        console.log(`[TITRARI][CACHE] Cautare identica in curs, reutilizez.`);
        return activeSearches.get(cacheKey);
    }

    const now = Date.now();
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        console.log(`[TITRARI][CACHE] Rezultat recent in cache.`);
        return cached.data;
    }

    const searchPromise = (async () => {
        const cleanImdbId = imdbId.split(':')[0];
        const imdbNum = cleanImdbId.replace(/^tt/i, '');

        let results = [];

        // METODA 1: imdb id nativ
        console.log(`[TITRARI] Metoda 1 — IMDB id: tt${imdbNum}`);
        const html1 = await fetchSearchPage({ z5: imdbNum });
        results = parseResults(html1);
        console.log(`[TITRARI] Metoda 1 → ${results.length} rezultate`);

        // METODA 2: titlu + an (daca avem meta din Cinemeta si metoda 1 a dat putin)
        if (results.length < 3 && meta && meta.name) {
            console.log(`[TITRARI] Metoda 2 — Titlu+An: "${meta.name}"`);
            const params2 = { z2: meta.name };
            if (meta.year) params2.z7 = String(meta.year).substring(0, 4);
            const html2 = await fetchSearchPage(params2);
            const results2 = parseResults(html2);
            console.log(`[TITRARI] Metoda 2 → ${results2.length} rezultate`);

            // Adaugam doar cele care nu sunt deja in lista (dedup dupa id)
            const seenIds = new Set(results.map(r => r.id));
            for (const r of results2) {
                if (!seenIds.has(r.id)) {
                    results.push(r);
                    seenIds.add(r.id);
                }
            }
        }

        // METODA 3: doar titlu, ultima plasa
        if (results.length < 3 && meta && meta.name) {
            console.log(`[TITRARI] Metoda 3 — Doar titlu: "${meta.name}"`);
            const html3 = await fetchSearchPage({ z2: meta.name });
            const results3 = parseResults(html3);
            console.log(`[TITRARI] Metoda 3 → ${results3.length} rezultate`);

            const seenIds = new Set(results.map(r => r.id));
            for (const r of results3) {
                if (!seenIds.has(r.id)) {
                    results.push(r);
                    seenIds.add(r.id);
                }
            }
        }

        console.log(`[TITRARI] Total final: ${results.length} subtitrari`);
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

function clearTitrariCache() {
    const count = searchCache.size;
    searchCache.clear();
    activeSearches.clear();
    return count;
}

module.exports = { searchTitrari, clearTitrariCache };