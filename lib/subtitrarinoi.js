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

async function searchMovies(title, year) {
    try {
        const params = {
            search_q: '1',
            query_q: title,
            cautare: title,
            tip: '2',
            an: year ? String(year) : '',
            gen: ''
        };
        const res = await axios.get(`${BASE_URL}/paginare_filme.php`, {
            params,
            headers: HEADERS,
            timeout: 10000
        });
        return res.data;
    } catch (err) {
        console.error(`[SUBTITRARINOI] Eroare cautare:`, err.message);
        return null;
    }
}

async function getDownloadLinksFromMoviePage(movieId) {
    try {
        const res = await axios.get(`${BASE_URL}/index.php`, {
            params: { page: 'movie_details', act: '1', id: movieId },
            headers: HEADERS,
            timeout: 10000
        });
        const html = res.data;
        const $ = cheerio.load(html);
        const results = [];

        $('a[href*="subtitrari-noi.ro"][href$=".zip"]').each((i, el) => {
            const href = $(el).attr('href') || '';
            if (!href.includes('-subtitrari-noi.ro-')) return;

            const match = href.match(/(\d+)-subtitrari-noi\.ro-(.+)-(\d+)\.zip$/i);
            if (!match) return;

            const subId = match[3];
            const titleRaw = match[2].replace(/_/g, ' ').replace(/\./g, ' ').trim();
            const downloadUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;

            // Descarcari din acelasi bloc
            let downloads = 0;
            const blockHtml = $(el).closest('[id="content"]').html() || '';
            const dlMatch = blockHtml.match(/Descarcari:\s*(\d+)/i);
            if (dlMatch) downloads = parseInt(dlMatch[1]);

            results.push({
                id: `${movieId}-${subId}`,
                title: titleRaw,
                url: downloadUrl,
                downloads,
                lang: 'ron',
                source: 'subtitrarinoi'
            });
        });

        return results;
    } catch (err) {
        console.error(`[SUBTITRARINOI] Eroare movie page ${movieId}:`, err.message);
        return [];
    }
}

function parseMovieIds(html) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const ids = [];
    const seen = new Set();

    $('a[href*="movie_details"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const idMatch = href.match(/id=(\d+)/);
        if (idMatch && !seen.has(idMatch[1])) {
            ids.push(idMatch[1]);
            seen.add(idMatch[1]);
        }
    });

    return ids;
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

        let movieIds = [];

        // METODA 1: titlu + an ca parametri separati
        console.log(`[SUBTITRARINOI] Metoda 1 — "${meta.name}" an=${meta.year || ''}`);
        const html1 = await searchMovies(meta.name, meta.year);
        movieIds = parseMovieIds(html1);
        console.log(`[SUBTITRARINOI] Metoda 1 → ${movieIds.length} filme gasite`);

        // METODA 2: doar titlu fara an
        if (movieIds.length === 0 && meta.name) {
            console.log(`[SUBTITRARINOI] Metoda 2 — "${meta.name}" fara an`);
            const html2 = await searchMovies(meta.name, null);
            const ids2 = parseMovieIds(html2);
            console.log(`[SUBTITRARINOI] Metoda 2 → ${ids2.length} filme gasite`);
            const seen = new Set(movieIds);
            for (const id of ids2) {
                if (!seen.has(id)) { movieIds.push(id); seen.add(id); }
            }
        }

        // Extragem subtitrările pentru fiecare film găsit
        let results = [];
        for (const movieId of movieIds.slice(0, 3)) {
            console.log(`[SUBTITRARINOI] Fetch subtitrari movie id: ${movieId}`);
            const subs = await getDownloadLinksFromMoviePage(movieId);
            console.log(`[SUBTITRARINOI] → ${subs.length} subtitrari`);
            const seenIds = new Set(results.map(r => r.id));
            for (const s of subs) {
                if (!seenIds.has(s.id)) { results.push(s); seenIds.add(s.id); }
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
