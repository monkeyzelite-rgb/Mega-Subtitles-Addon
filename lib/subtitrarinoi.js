// lib/subtitrarinoi.js
const axios = require('axios');
const cheerio = require('cheerio');
const cacheDb = require('./cacheStore');
const BoundedCache = require('./boundedCache');

const BASE_URL = 'https://www.subtitrari-noi.ro';
const MEM_TTL_MS = 5 * 60 * 1000;
const searchCache = new BoundedCache({ ttlMs: MEM_TTL_MS, maxEntries: 300 });
const activeSearches = new Map();

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Referer': `${BASE_URL}/index.php?page=filme`,
    'X-Requested-With': 'XMLHttpRequest'
};

function normalizeTitle(t) {
    return (t || '')
        .toLowerCase()
        .replace(/\((19|20)\d{2}\)/g, ' ')
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/\/.*$/, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titlesMatch(found, wanted) {
    const f = normalizeTitle(found);
    const w = normalizeTitle(wanted);
    if (!f || !w) return false;
    if (f === w) return true;

    const fTokens = f.split(' ').filter(Boolean);
    const wTokens = w.split(' ').filter(Boolean);

    if (wTokens.length === 1 && wTokens[0].length <= 3) {
        return fTokens.length === 1 && fTokens[0] === wTokens[0];
    }

    const significant = wTokens.filter(t => t.length > 2);
    if (significant.length === 0) return f === w;
    const matched = significant.filter(t => fTokens.includes(t)).length;
    return matched === significant.length;
}

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

function parseMovieResults(html) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    $('a[href*="movie_details"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const idMatch = href.match(/id=(\d+)/);
        if (!idMatch) return;
        const id = idMatch[1];
        if (seen.has(id)) return;

        const text = $(el).text().trim();
        if (!text || text.toLowerCase() === 'detalii') return;

        seen.add(id);
        results.push({ id, title: text });
    });

    return results;
}

async function searchSubtitrariNoi(imdbId, type, meta) {
    const cacheKey = `subtitrarinoi:${type}:${imdbId}`;

    if (activeSearches.has(cacheKey)) {
        console.log(`[SUBTITRARINOI][CACHE] Cautare identica in curs.`);
        return activeSearches.get(cacheKey);
    }

    const cached = searchCache.get(cacheKey);
    if (cached) {
        console.log(`[SUBTITRARINOI][CACHE-MEM] Rezultat recent in memorie.`);
        return cached;
    }

    const fromDb = await cacheDb.getSearch(cacheKey);
    if (fromDb) {
        console.log(`[SUBTITRARINOI][CACHE-DB] ${fromDb.length} subtitrari din disc.`);
        searchCache.set(cacheKey, fromDb);
        return fromDb;
    }

    const searchPromise = (async () => {
        if (!meta || !meta.name) {
            console.log(`[SUBTITRARINOI] Fara meta, skip.`);
            return [];
        }

        const wantedTitle = meta.name;
        const wantedYear = meta.year ? String(meta.year).substring(0, 4) : null;

        let movies = [];

        console.log(`[SUBTITRARINOI] Metoda 1 — "${wantedTitle}" an=${wantedYear || ''}`);
        const html1 = await searchMovies(wantedTitle, wantedYear);
        movies = parseMovieResults(html1);
        console.log(`[SUBTITRARINOI] Metoda 1 → ${movies.length} filme brute`);

        if (movies.length === 0) {
            console.log(`[SUBTITRARINOI] Metoda 2 — "${wantedTitle}" fara an`);
            const html2 = await searchMovies(wantedTitle, null);
            movies = parseMovieResults(html2);
            console.log(`[SUBTITRARINOI] Metoda 2 → ${movies.length} filme brute`);
        }

        const relevant = movies.filter(m => titlesMatch(m.title, wantedTitle));
        console.log(`[SUBTITRARINOI] ${relevant.length} filme relevante din ${movies.length}`);
        if (relevant.length > 0) {
            console.log(`[SUBTITRARINOI] Relevante: ${relevant.map(r => `"${r.title}"`).join(', ')}`);
        }

        if (relevant.length === 0) {
            console.log(`[SUBTITRARINOI] Niciun film relevant pentru "${wantedTitle}".`);
            return [];
        }

        let results = [];
        for (const movie of relevant.slice(0, 3)) {
            console.log(`[SUBTITRARINOI] Fetch subtitrari: "${movie.title}" (id ${movie.id})`);
            const subs = await getDownloadLinksFromMoviePage(movie.id);
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
        searchCache.set(cacheKey, result);
        if (result.length > 0) await cacheDb.setSearch(cacheKey, result);
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
