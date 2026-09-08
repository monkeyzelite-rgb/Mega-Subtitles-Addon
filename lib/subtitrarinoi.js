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
    'Referer': BASE_URL
};

// Cautare prin IMDB id via API-ul lor intern
async function searchByImdb(imdbId) {
    try {
        const res = await axios.get(`${BASE_URL}/index.php`, {
            params: { page: 'cautare', imdb: imdbId },
            headers: HEADERS,
            timeout: 10000
        });
        return res.data;
    } catch (err) {
        console.error(`[SUBTITRARINOI] Eroare IMDB search:`, err.message);
        return null;
    }
}

// Pagina principala cu lista de filme — cautam dupa titlu+an in URL-urile filmelor
async function searchMovieList(query) {
    try {
        const res = await axios.get(`${BASE_URL}/index.php`, {
            params: { page: 'filme' },
            headers: HEADERS,
            timeout: 10000
        });
        return res.data;
    } catch (err) {
        console.error(`[SUBTITRARINOI] Eroare lista filme:`, err.message);
        return null;
    }
}

// Extrage linkurile de download dintr-o pagina movie_details
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

        // Pattern URL: /ID-subtitrari-noi.ro-Titlu-SubId.zip
        $('a[href*="subtitrari-noi.ro"][href$=".zip"]').each((i, el) => {
            const href = $(el).attr('href') || '';
            if (!href.includes('-subtitrari-noi.ro-')) return;

            // Extragem sub_id din finalul URL-ului
            const match = href.match(/(\d+)-subtitrari-noi\.ro-(.+)-(\d+)\.zip$/i);
            if (!match) return;

            const subId = match[3];
            const titleRaw = match[2].replace(/_/g, ' ').replace(/\./g, ' ').trim();

            results.push({
                id: `${movieId}-${subId}`,
                title: titleRaw,
                url: href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`,
                downloads: 0,
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

// Gasim ID-ul filmului pe subtitrari-noi.ro dupa titlu+an
async function findMovieId(title, year) {
    try {
        // Cautam in pagina principala de filme dupa titlu
        const query = year ? `${title} ${year}` : title;
        const res = await axios.get(`${BASE_URL}/index.php`, {
            params: { page: 'filme', search: query },
            headers: HEADERS,
            timeout: 10000
        });
        const html = res.data;
        const $ = cheerio.load(html);

        // Cautam link-uri catre movie_details
        const movieIds = [];
        $('a[href*="movie_details"]').each((i, el) => {
            const href = $(el).attr('href') || '';
            const idMatch = href.match(/id=(\d+)/);
            if (idMatch) movieIds.push(idMatch[1]);
        });

        // Fallback: cautam direct in HTML dupa pattern-ul id-ului
        if (movieIds.length === 0) {
            const idMatches = html.match(/movie_details&act=1&id=(\d+)/g);
            if (idMatches) {
                idMatches.forEach(m => {
                    const id = m.match(/id=(\d+)/)[1];
                    if (!movieIds.includes(id)) movieIds.push(id);
                });
            }
        }

        console.log(`[SUBTITRARINOI] Movie IDs gasite pentru "${query}": ${movieIds.slice(0,5).join(', ')}`);
        return movieIds.slice(0, 3); // primele 3 rezultate
    } catch (err) {
        console.error(`[SUBTITRARINOI] Eroare findMovieId:`, err.message);
        return [];
    }
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
        let results = [];

        if (!meta || !meta.name) {
            console.log(`[SUBTITRARINOI] Fara meta, skip.`);
            return [];
        }

        // METODA 1: gasim ID-ul filmului dupa titlu+an
        console.log(`[SUBTITRARINOI] Caut film: "${meta.name}" (${meta.year || '?'})`);
        const movieIds = await findMovieId(meta.name, meta.year);

        // Pentru fiecare ID de film gasit, extragem subtitrările
        for (const movieId of movieIds) {
            console.log(`[SUBTITRARINOI] Fetch subtitrari pentru movie id: ${movieId}`);
            const subs = await getDownloadLinksFromMoviePage(movieId);
            console.log(`[SUBTITRARINOI] → ${subs.length} subtitrari`);

            const seenIds = new Set(results.map(r => r.id));
            for (const s of subs) {
                if (!seenIds.has(s.id)) {
                    results.push(s);
                    seenIds.add(s.id);
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
