// lib/cacheStore.js
// Alege automat backend-ul de cache: SQLite local (lib/cache.js, neschimbat —
// asta va rula pe Raspberry Pi) sau Redis (lib/cacheRedis.js — asta ruleaza pe
// Vercel, unde nu exista disc persistent intre invocari).
//
// Interfata publica e ASYNC indiferent de backend, ca apelantii sa nu trebuiasca
// sa stie care e in uz — SQLite e sincron pe dinauntru, dar invelit intr-o
// functie async devine automat o Promisiune rezolvata, deci await functioneaza
// identic pe ambele.

const USE_REDIS = !!process.env.UPSTASH_REDIS_REST_URL;
const impl = USE_REDIS ? require('./cacheRedis') : require('./cache');

console.log(`[CACHE] Backend activ: ${USE_REDIS ? 'Redis (Upstash)' : 'SQLite (local)'}`);

module.exports = {
    getSearch:   async (key)          => impl.getSearch(key),
    setSearch:   async (key, data)    => impl.setSearch(key, data),
    getSubtitle: async (key)          => impl.getSubtitle(key),
    setSubtitle: async (key, content) => impl.setSubtitle(key, content),
    stats:       async ()             => impl.stats(),
    clearAll:    async ()             => impl.clearAll(),
    cleanup:     async ()             => impl.cleanup(),
    isAvailable: () => impl.isAvailable(),
    backend: USE_REDIS ? 'redis' : 'sqlite'
};
