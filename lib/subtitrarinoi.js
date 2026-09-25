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

// Redus de la 10000ms: cand siteul e jos/foarte lent, o cautare care incearca
// Metoda 1 SI Metoda 2 (ambele cu timeout complet) putea bloca raspunsul catre
// Stremio ~20s doar pentru aceasta sursa, desi celelalte 3 surse raspundeau
// normal — confirmat direct pe productie (2x "timeout of 10000ms exceeded").
const SEARCH_TIMEOUT_MS = 5000;

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
            timeout: SEARCH_TIMEOUT_MS
        });
        return { html: res.data, timedOut: false };
    } catch (err) {
        const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
        console.error(`[SUBTITRARINOI] Eroare cautare${timedOut ? ' (timeout)' : ''}:`, err.message);
        return { html: null, timedOut };
    }
}

async function getDownloadLinksFromMoviePage(movieId) {
    try {
        const res = await axios.get(`${BASE_URL}/index.php`, {
            params: { page: 'movie_details', act: '1', id: movieId },
            headers: HEADERS,
            timeout: SEARCH_TIMEOUT_MS
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
        const r1 = await searchMovies(wantedTitle, wantedYear);
        movies = parseMovieResults(r1.html);
        console.log(`[SUBTITRARINOI] Metoda 1 → ${movies.length} filme brute`);

        // Daca Metoda 1 a picat din TIMEOUT (nu doar 0 rezultate), siteul e
        // indisponibil chiar acum — o a doua incercare cu aceiasi parametri de
        // retea ar astepta inca un timeout intreg, cu sansa reala de succes ~0.
        // Renuntam direct, ca sa nu dublam degeaba intarzierea pentru userul care
        // asteapta raspunsul (celelalte 3 surse tot raspund normal).
        if (movies.length === 0 && r1.timedOut) {
            console.log(`[SUBTITRARINOI] Metoda 1 a expirat — site indisponibil momentan, renunt fara Metoda 2.`);
        } else if (movies.length === 0) {
            console.log(`[SUBTITRARINOI] Metoda 2 — "${wantedTitle}" fara an`);
            const r2 = await searchMovies(wantedTitle, null);
            movies = parseMovieResults(r2.html);
            console.log(`[SUBTITRARINOI] Metoda 2 → ${movies.length} filme brute`);
        }

        // Lista siteului arata anul langa titlu ("Mayday (2026)") — un film cu
        // acelasi nume din alt an (remake, alt film) e exclus, cu toleranta +-1 an.
        const yearOf = (t) => { const m = String(t).match(/\((19|20)\d{2}\)/); return m ? parseInt(m[0].slice(1, 5), 10) : null; };
        const relevant = movies.filter(m => titlesMatch(m.title, wantedTitle) &&
            (!wantedYear || yearOf(m.title) == null || Math.abs(yearOf(m.title) - parseInt(wantedYear, 10)) <= 1));
        console.log(`[SUBTITRARINOI] ${relevant.length} filme relevante din ${movies.length}`);
        if (relevant.length > 0) {
            console.log(`[SUBTITRARINOI] Relevante: ${relevant.map(r => `"${r.title}"`).join(', ')}`);
        }

        if (relevant.length === 0) {
            console.log(`[SUBTITRARINOI] Niciun film relevant pentru "${wantedTitle}".`);
            return [];
        }

        // Cele (pana la 3) pagini de detalii sunt complet independente una de
        // alta — nu exista niciun motiv sa asteptam raspunsul uneia inainte sa o
        // cerem pe urmatoarea. Secvential (await in for) insemna ca timpul total
        // era SUMA celor 3 cereri (pana la 30s la un site lent), desi celelalte 3
        // surse ruleaza deja in paralel intre ele (addon.js, Promise.allSettled) —
        // asta facea din aceasta bucla singurul bottleneck real la o cautare noua,
        // necache-uita. Paralel, timpul total devine MAXIMUL celor 3, nu suma.
        console.log(`[SUBTITRARINOI] Fetch in paralel pentru ${Math.min(relevant.length, 3)} rezultate.`);
        const pages = await Promise.all(relevant.slice(0, 3).map(async movie => {
            const subs = await getDownloadLinksFromMoviePage(movie.id);
            console.log(`[SUBTITRARINOI] → ${subs.length} subtitrari ("${movie.title}", id ${movie.id})`);
            return subs;
        }));
        let results = [];
        const seenIds = new Set();
        for (const subs of pages) {
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
