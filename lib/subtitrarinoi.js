// lib/subtitrarinoi.js
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.subtitrari-noi.ro';
const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map();
const activeSearches = new Map();

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Referer': `${BASE_URL}/index.php?page=filme`,
    'X-Requested-With': 'XMLHttpRequest'
};

// Cauta filme dupa titlu — returneaza lista de {movieId, title, downloads, downloadUrl}
async function searchMovies(query) {
    try {
        const res = await axios.get(`${BASE_URL}/paginare_filme.php`, {
            params: {
                search_q: '1',
                query_q: query,
                cautare: query,
                tip: '2',
                an: '',
                gen: ''
            },
            headers: HEADERS,
            timeout: 10000
        });
        return res.data;
    } catch (err) {
        console.error(`[SUBTITRARINOI] Eroare cautare "${query}":`, err.message);
        return null;
    }
}

function parseSearchResults(html) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const results = [];
    const seenIds = new Set();

    // Fiecare film are: link movie_details cu id, link download .zip, Descarcari
    $('a[href*="movie_details"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const idMatch = href.match(/id=(\d+)/);
        if (!idMatch) return;
        const movieId = idMatch[1];
        if (seenIds.has(movieId)) return;
        seenIds.add(movieId);

        // Container parinte
        const container = $(el).closest('#content, div[id="round"], div');

        // Download URL — link .zip din acelasi bloc
        let downloadUrl = null;
        let downloads = 0;
        let releaseTitle = '';

        // Cautam in tot HTML-ul blocului
        const blockHtml = $(el).closest('[id="round"]').html() ||
                          $(el).parent().parent().html() || '';

        // Download link
        const zipMatch = blockHtml.match(/href=['"]?(\d+-subtitrari-noi\.ro-[^'">\s]+\.zip)['"]?/i);
        if (zipMatch) {
            downloadUrl = zipMatch[1].startsWith('http')
                ? zipMatch[1]
                : `${BASE_URL}/${zipMatch[1]}`;
        }

        // Descarcari
        const dlMatch = blockHtml.match(/Descarcari:\s*(\d+)/i);
        if (dlMatch) downloads = parseInt(dlMatch[1]);

        // Titlul release-ului din textul bold de jos
        const releaseMatch = blockHtml.match(/font-style:italic[^>]*>([^<(]+)/i);
        if (releaseMatch) releaseTitle = releaseMatch[1].trim();

        // Titlul filmului
        const title = $(el).text().trim() || releaseTitle || `SubtitrariNoi-${movieId}`;

        if (!downloadUrl) return; // skip daca nu avem URL de download

        results.push({
            id: `${movieId}`,
            title: releaseTitle || title,
            url: downloadUrl,
            downloads,
            lang: 'ron',
            source: 'subtitrarinoi'
        });
    });

    return results;
}

async function searchSubtitrariNoi(imdbId, type, meta) {
    const cacheKey = `subtitrarinoi:${type}:${imdbId}`;

    if (activeSearches.has(cacheKey)) {
        console.log(`[SUBTITRARINOI][CACHE] Cautare identica in curs.`);
        return activeSearches.get(cacheKey);
    }

    const now = Date.now();
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        console.log(`[SUBTITRARINOI][CACHE] Rezultat recent in cache.`);
        return cached.data;
    }

    const searchPromise = (async () => {
        if (!meta || !meta.name) {
            console.log(`[SUBTITRARINOI] Fara meta, skip.`);
            return [];
        }

        let results = [];

        // METODA 1: titlu + an
        const query1 = meta.year ? `${meta.name} ${meta.year}` : meta.name;
        console.log(`[SUBTITRARINOI] Metoda 1 — "${query1}"`);
        const html1 = await searchMovies(query1);
        results = parseSearchResults(html1);
        console.log(`[SUBTITRARINOI] Metoda 1 → ${results.length} rezultate`);

        // METODA 2: doar titlu daca prea putine rezultate
        if (results.length < 2 && meta.name) {
            console.log(`[SUBTITRARINOI] Metoda 2 — "${meta.name}"`);
            const html2 = await searchMovies(meta.name);
            const results2 = parseSearchResults(html2);
            console.log(`[SUBTITRARINOI] Metoda 2 → ${results2.length} rezultate`);

            const seenIds = new Set(results.map(r => r.id));
            for (const r of results2) {
                if (!seenIds.has(r.id)) {
                    results.push(r);
                    seenIds.add(r.id);
                }
            }
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
