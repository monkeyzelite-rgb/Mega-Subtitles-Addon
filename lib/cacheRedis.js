// lib/cacheRedis.js
// Backend de cache pentru rulare pe Vercel (sau oriunde nu exista disc
// persistent) — Upstash Redis prin API REST, cu acelasi rol ca lib/cache.js
// (SQLite): cautari (7 zile) si continut de subtitrari descarcate (90 zile).
//
// Spre deosebire de SQLite, Redis expira intrarile singur prin TTL nativ —
// nu mai e nevoie de cleanup()/vacuum periodic.

const SEARCH_TTL_SECONDS   = 7  * 24 * 60 * 60; // 7 zile
const SUBTITLE_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 zile

let redis = null;
let available = false;

function init() {
    try {
        const { Redis } = require('@upstash/redis');
        const url = process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.UPSTASH_REDIS_REST_TOKEN;
        if (!url || !token) {
            console.warn('[CACHE-REDIS] UPSTASH_REDIS_REST_URL/TOKEN lipsesc — cache indisponibil.');
            return;
        }
        redis = new Redis({ url, token });
        available = true;
        console.log('[CACHE-REDIS] Initializat (Upstash Redis).');
    } catch (err) {
        console.warn(`[CACHE-REDIS] Indisponibil (${err.message}).`);
        available = false;
    }
}

// === CAUTARI ===

async function getSearch(key) {
    if (!available) return null;
    try {
        return await redis.get(`search:${key}`);
    } catch (err) {
        console.error('[CACHE-REDIS] Eroare getSearch:', err.message);
        return null;
    }
}

async function setSearch(key, data) {
    if (!available) return;
    try {
        await redis.set(`search:${key}`, data, { ex: SEARCH_TTL_SECONDS });
    } catch (err) {
        console.error('[CACHE-REDIS] Eroare setSearch:', err.message);
    }
}

// === SUBTITRARI DESCARCATE ===

async function getSubtitle(key) {
    if (!available) return null;
    try {
        return await redis.get(`sub:${key}`);
    } catch (err) {
        console.error('[CACHE-REDIS] Eroare getSubtitle:', err.message);
        return null;
    }
}

async function setSubtitle(key, content) {
    if (!available) return;
    try {
        await redis.set(`sub:${key}`, content, { ex: SUBTITLE_TTL_SECONDS });
    } catch (err) {
        console.error('[CACHE-REDIS] Eroare setSubtitle:', err.message);
    }
}

// === ADMINISTRARE ===

async function stats() {
    if (!available) return { available: false };
    try {
        const dbsize = await redis.dbsize();
        return { available: true, backend: 'redis', keys: dbsize };
    } catch {
        return { available: true, backend: 'redis', error: true };
    }
}

async function clearAll() {
    if (!available) return 0;
    try {
        const dbsize = await redis.dbsize();
        await redis.flushdb();
        return dbsize;
    } catch (err) {
        console.error('[CACHE-REDIS] Eroare clearAll:', err.message);
        return 0;
    }
}

// TTL-ul Redis expira singur intrarile — nimic de facut aici. Pastram functia
// doar ca interfata sa ramana identica cu lib/cache.js (SQLite).
async function cleanup() {}

init();

module.exports = {
    getSearch, setSearch,
    getSubtitle, setSubtitle,
    stats, clearAll, cleanup,
    isAvailable: () => available
};
