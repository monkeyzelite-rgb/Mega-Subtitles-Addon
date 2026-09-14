// lib/cache.js
// Cache persistent pe disc (SQLite) — supravietuieste repornirii serverului.
// Doua tabele:
//   searches  — rezultatele cautarilor per sursa (expira in 7 zile)
//   subtitles — continutul subtitrarilor descarcate (expira in 90 zile)

const path = require('path');
const fs = require('fs');

let db = null;
let available = false;

// TTL-uri
const SEARCH_TTL_MS   = 7  * 24 * 60 * 60 * 1000;  // 7 zile
const SUBTITLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;  // 90 zile

function init() {
    try {
        const Database = require('better-sqlite3');
        const dbDir = path.join(__dirname, '..', 'data');
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

        const dbPath = path.join(dbDir, 'cache.db');
        db = new Database(dbPath);

        // WAL = scrieri mai rapide, important pe Raspberry Pi (card SD)
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');

        // auto_vacuum incremental: dupa un DELETE, SQLite nu elibereaza spatiul
        // pe disc (fisierul creste la nesfarsit chiar daca randurile sunt sterse
        // logic) decat printr-un VACUUM — dar un VACUUM complet rescrie tot
        // fisierul si blocheaza procesul cat dureaza. Modul incremental permite
        // eliberarea spatiului treptat, in bucati mici (vezi incrementalVacuum
        // mai jos), fara acel hiccup. Comutarea modului pe o baza existenta cere
        // un singur VACUUM complet, o singura data, ca sa se aplice.
        if (db.pragma('auto_vacuum', { simple: true }) !== 2) {
            db.pragma('auto_vacuum = INCREMENTAL');
            db.exec('VACUUM');
        }

        db.exec(`
            CREATE TABLE IF NOT EXISTS searches (
                key        TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_searches_exp ON searches(expires_at);

            CREATE TABLE IF NOT EXISTS subtitles (
                key        TEXT PRIMARY KEY,
                content    TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                hits       INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_subtitles_exp ON subtitles(expires_at);
        `);

        available = true;
        console.log(`[CACHE-DB] Initializat: ${dbPath}`);

        // Curatam intrarile expirate la pornire
        cleanup();
    } catch (err) {
        console.warn(`[CACHE-DB] Indisponibil (${err.message}) — folosesc doar cache in memorie.`);
        available = false;
    }
}

function cleanup() {
    if (!available) return;
    try {
        const now = Date.now();
        const s = db.prepare('DELETE FROM searches WHERE expires_at < ?').run(now);
        const t = db.prepare('DELETE FROM subtitles WHERE expires_at < ?').run(now);
        if (s.changes || t.changes) {
            console.log(`[CACHE-DB] Curatat: ${s.changes} cautari + ${t.changes} subtitrari expirate.`);
        }
        incrementalVacuum();
    } catch (err) {
        console.error('[CACHE-DB] Eroare cleanup:', err.message);
    }
}

// Elibereaza pe disc spatiul lasat liber de DELETE-uri, in bucati mici
// (max 1000 pagini ~ 4MB per rulare) — rapid, fara sa blocheze procesul
// asa cum ar face un VACUUM complet pe o baza mare.
function incrementalVacuum() {
    if (!available) return;
    try {
        db.pragma('incremental_vacuum(1000)');
    } catch (err) {
        console.error('[CACHE-DB] Eroare incremental_vacuum:', err.message);
    }
}

// === CAUTARI ===

function getSearch(key) {
    if (!available) return null;
    try {
        const row = db.prepare('SELECT data, expires_at FROM searches WHERE key = ?').get(key);
        if (!row) return null;
        if (row.expires_at < Date.now()) {
            db.prepare('DELETE FROM searches WHERE key = ?').run(key);
            return null;
        }
        return JSON.parse(row.data);
    } catch (err) {
        console.error('[CACHE-DB] Eroare getSearch:', err.message);
        return null;
    }
}

function setSearch(key, data) {
    if (!available) return;
    try {
        const now = Date.now();
        db.prepare(`
            INSERT INTO searches (key, data, created_at, expires_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                data = excluded.data,
                created_at = excluded.created_at,
                expires_at = excluded.expires_at
        `).run(key, JSON.stringify(data), now, now + SEARCH_TTL_MS);
    } catch (err) {
        console.error('[CACHE-DB] Eroare setSearch:', err.message);
    }
}

// === SUBTITRARI DESCARCATE ===

function getSubtitle(key) {
    if (!available) return null;
    try {
        const row = db.prepare('SELECT content, expires_at FROM subtitles WHERE key = ?').get(key);
        if (!row) return null;
        if (row.expires_at < Date.now()) {
            db.prepare('DELETE FROM subtitles WHERE key = ?').run(key);
            return null;
        }
        // Contorizam accesarile ca sa stim ce merita pastrat
        db.prepare('UPDATE subtitles SET hits = hits + 1 WHERE key = ?').run(key);
        return row.content;
    } catch (err) {
        console.error('[CACHE-DB] Eroare getSubtitle:', err.message);
        return null;
    }
}

function setSubtitle(key, content) {
    if (!available) return;
    try {
        const now = Date.now();
        db.prepare(`
            INSERT INTO subtitles (key, content, created_at, expires_at, hits)
            VALUES (?, ?, ?, ?, 0)
            ON CONFLICT(key) DO UPDATE SET
                content = excluded.content,
                created_at = excluded.created_at,
                expires_at = excluded.expires_at
        `).run(key, content, now, now + SUBTITLE_TTL_MS);
    } catch (err) {
        console.error('[CACHE-DB] Eroare setSubtitle:', err.message);
    }
}

// === ADMINISTRARE ===

function stats() {
    if (!available) return { available: false };
    try {
        const s = db.prepare('SELECT COUNT(*) AS n FROM searches').get();
        const t = db.prepare('SELECT COUNT(*) AS n FROM subtitles').get();
        const size = db.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get();
        return {
            available: true,
            searches: s.n,
            subtitles: t.n,
            sizeMB: (size.bytes / 1024 / 1024).toFixed(2)
        };
    } catch {
        return { available: true, error: true };
    }
}

function clearAll() {
    if (!available) return 0;
    try {
        const s = db.prepare('DELETE FROM searches').run();
        const t = db.prepare('DELETE FROM subtitles').run();
        db.exec('VACUUM');
        return s.changes + t.changes;
    } catch (err) {
        console.error('[CACHE-DB] Eroare clearAll:', err.message);
        return 0;
    }
}

init();

module.exports = {
    getSearch, setSearch,
    getSubtitle, setSubtitle,
    stats, clearAll, cleanup,
    isAvailable: () => available
};