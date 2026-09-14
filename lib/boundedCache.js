// lib/boundedCache.js
// Cache in memorie cu TTL + limita de dimensiune (LRU).
//
// Toate cache-urile din proiect (search-uri per sursa, subtitrari descarcate)
// foloseau un `Map` simplu: TTL-ul era verificat doar cand cineva mai cerea
// exact aceeasi cheie, dar o intrare expirata si nemaiceruta ramanea in Map
// la nesfarsit. Cum utilizatorii cauta mereu titluri diferite, numarul de chei
// unice crestea nemarginit cat timp rula procesul — heap tot mai mare, GC tot
// mai lent, deci cautari/incarcari/descarcari tot mai lente, indiferent de sursa.
// Acest cache evacueaza activ cea mai veche intrare cand se depaseste `maxEntries`.

class BoundedCache {
    constructor({ ttlMs, maxEntries }) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.map = new Map();
    }

    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            this.map.delete(key);
            return undefined;
        }
        // Map pastreaza ordinea de inserare — mutam cheia la final ca sa
        // implementam LRU (cea mai veche neaccesata e mereu prima evacuata)
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.data;
    }

    has(key) {
        return this.get(key) !== undefined;
    }

    set(key, data) {
        this.map.delete(key);
        this.map.set(key, { data, expiresAt: Date.now() + this.ttlMs });
        while (this.map.size > this.maxEntries) {
            const oldestKey = this.map.keys().next().value;
            this.map.delete(oldestKey);
        }
    }

    get size() {
        return this.map.size;
    }

    clear() {
        const count = this.map.size;
        this.map.clear();
        return count;
    }
}

module.exports = BoundedCache;
