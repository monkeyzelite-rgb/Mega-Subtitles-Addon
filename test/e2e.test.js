// Test end-to-end: porneste server.js real, cu raspunsurile site-urilor
// (RegieLive, Titrari, Subs.ro, Subtitrari-noi, Cinemeta) simulate — fara retea.
// Verifica ce subtitrare iese prima si ce fisier se extrage din arhive.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');

process.env.SUBSRO_API_KEY = 'test-key';
process.env.APP_URL = 'http://127.0.0.1:0';
delete process.env.UPSTASH_REDIS_REST_URL;

// Cache doar in memorie — SQLite-ul din data/ ar pastra rezultate intre rulari.
const mem = new Map();
require.cache[require.resolve('../lib/cacheStore')] = { exports: {
    getSearch: async (k) => mem.get('s:' + k) || null, setSearch: async (k, d) => { mem.set('s:' + k, d); },
    getSubtitle: async (k) => mem.get('t:' + k) || null, setSubtitle: async (k, c) => { mem.set('t:' + k, c); },
    stats: async () => ({ available: false }), clearAll: async () => mem.clear(), cleanup: async () => {},
    isAvailable: () => false, backend: 'memory',
} };

const axios = require('axios');
const AdmZip = require('adm-zip');

const srt = (label) => `1\r\n00:00:01,000 --> 00:00:03,000\r\n${label}\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\n3\r\n\r\n3\r\n00:00:06,000 --> 00:00:07,000\r\n2\r\n`;
function zipOf(files) { const z = new AdmZip(); for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.from(c)); return z.toBuffer(); }

// ---------- fixture-uri ----------
const SERIES = 'tt1234567', MOVIE = 'tt0228333', MAYDAY = 'tt28014327';
let rlCalls = [];
let cinemetaCalls = 0;
const rlSub = (id, titlu, nota) => [id, { titlu, url: `https://subtitrari.regielive.ro/descarca-${id}.zip`, rating: { nota } }];
// exact lista din log-ul de productie (25 sept. 2026, "Mayday_2026_1080p_RHS.mkv")
const mayday2026 = [rlSub(8001, 'Mayday.2026.1080p.ATVP.WEB-DL.DD+5.1.Atmos.H.264-playWEB', 4.81), rlSub(8002, 'Mayday.2026.720p.WEBRip.x264.AAC-[YTS.GG - YTS.BZ]', 4.83)];
const maydayJunk = [rlSub(8101, 'Mayday 2021 1080p Bluray DTS-HD MA 5 1 X264-EVO', 5), rlSub(8102, 'Mayday.2021.1080p.WEBRip.DD5.1.x264-NOGRP', 4.75),
  rlSub(8103, 'Mayday.2021.1080p.WEBRip.x264-RARBG', 4.55), rlSub(8104, 'Mayday.2019.720p.WEB-DL.H264.AC3-EVO', 4.62), rlSub(8105, 'Mayday 2021 BRRip XviD AC3-EVO', 5),
  rlSub(8106, 'mayday.1x01.720p_hdtv_x264-fov', 5), rlSub(8107, 'Mayday.1x02.720p.hdtvx264-fov', 5)];
const rlResp = (list) => ({ rezultate: { f1: { film: 'Mayday', subtitrari: Object.fromEntries(list) } } });
const titrariRow = (id, title, dl, imdb) => `<tr><td><a href="get.php?id=${id}">Descarca</a></td><td><a href="index.php?page=cautamaiaparte&z5=${imdb}">film</a></td>
<td class=comment>Comentariu:</td><td class=comment>${title}</td><td>Descarcari: ${dl}</td></tr>`;
const titrariSeries = [
    [101, 'Show.Name.S02E05.720p.HDTV.x264-KILLERS', 500],
    [102, 'Show.Name.S02E04.1080p.WEB-DL.DDP5.1.H.264-NTb', 900],
    [103, 'Show Name Sezonul 2 complet 1080p WEB-DL', 3000],
    [104, 'Show.Name.S01E05.1080p.WEB-DL-NTb', 800],
    [105, 'Show.Name.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb', 50],
    [106, 'Show Name 2x05 WEBRip', 100],
    [107, 'Show Name Seasons 1-3 Complete', 5000],
].map(([id, t, dl]) => titrariRow(id, t, dl, '1234567')).join('\n');
const titrariMovie = [
    [201, 'Ghosts of Mars (2001) - traducere completa', 2000],
    [202, 'Ghosts.of.Mars.2001.EXTENDED.1080p.BluRay.x264-SPARKS', 4000],
    [203, 'Ghosts of Mars 2001 1080p', 300],
].map(([id, t, dl]) => titrariRow(id, t, dl, '0228333')).join('\n');

const rlSeries = { rezultate: { f1: { film: { nume: 'Show Name' }, subtitrari: {
    9001: { titlu: 'Show.Name.S02E05.1080p.WEB.H264-GHOSTS', url: 'https://subtitrari.regielive.ro/descarca-9001.zip', rating: { nota: 9.2 } },
    9002: { titlu: 'Show Name S02E05 pachet', url: 'https://subtitrari.regielive.ro/descarca-9002.zip', rating: { nota: 4 } },
} } } };
const rlMovie = { rezultate: { f1: { film: { nume: 'Ghosts of Mars' }, subtitrari: {
    9101: { titlu: 'Ghosts.of.Mars.2001.1080p.BluRay.x264-AMIABLE', url: 'https://subtitrari.regielive.ro/descarca-9101.zip', rating: { nota: 6 } },
    9102: { titlu: 'Ghosts of Mars 2001 DVDRip XviD', url: 'https://subtitrari.regielive.ro/descarca-9102.zip', rating: { nota: 9 } },
} } } };
const subsroSeries = { count: 1, items: [{ id: 3001, description: 'Show Name S02E05 - Secrets and Lies', language: 'ro', imdbid: SERIES, downloadLink: 'https://api.subs.ro/v1.0/subtitle/3001/download' }] };

// pachet de sezon: E05 (HDTV) + E06 (identic cu video-ul ca sursa/rezolutie/grup)
const seasonPack = zipOf({
    'Show.Name.S02E05.720p.HDTV.x264-KILLERS.srt': srt('EPISODUL 5'),
    'Show.Name.S02E06.1080p.WEB-DL.DDP5.1.H.264-NTb.srt': srt('EPISODUL 6'),
});
const microDvdPal = '{1}{1}25.000\r\n{250}{300}Zece secunde la 25fps\r\n';
const pad = (n) => String(n).padStart(2, '0');
const fullSeries = {};
for (let se = 1; se <= 3; se++) for (let ep = 1; ep <= 10; ep++) fullSeries[`Show.Name.S${pad(se)}E${pad(ep)}.720p.WEB-DL.srt`] = srt(`S${pad(se)}E${pad(ep)}`);
const archives = {
  '/descarca-full.zip': zipOf(fullSeries),
  '/descarca-folders.zip': zipOf({ 'Sezonul 1/Episodul 05.srt': srt('SEZ1-EP5'), 'Sezonul 2/Episodul 05.srt': srt('SEZ2-EP5'), 'Sezonul 2/Episodul 06.srt': srt('SEZ2-EP6') }),
  '/descarca-mixed.zip': zipOf({ 'Show.1x05.srt': srt('1x05'), 'Show.2x05.srt': srt('2x05'), 'Show.S02E15.srt': srt('S02E15'), 'Show.S12E05.srt': srt('S12E05'), 'Show S02 Ep06.srt': srt('S02EP06') }),
  '/descarca-nested.zip': zipOf({ 'Show.S01.zip': zipOf({ 'Show.S01E05.srt': srt('NESTED-S01E05') }), 'Show.S02.zip': zipOf({ 'Show.S02E05.srt': srt('NESTED-S02E05'), 'Show.S02E06.srt': srt('NESTED-S02E06') }), 'Show.S03.zip': zipOf({ 'Show.S03E05.srt': srt('NESTED-S03E05') }) }),
  '/descarca-single-wrong.zip': zipOf({ 'Show.Name.S02E04.720p.srt': srt('SINGLE-E04') }),
  '/descarca-single-generic.zip': zipOf({ 'subtitrare.srt': srt('SINGLE-GENERIC') }),
  '/descarca-single-otherseason.zip': zipOf({ 'Show.Season.3.srt': srt('SINGLE-SEASON3') }),
};

axios.defaults.adapter = async (config) => {
    const url = new URL(axios.getUri(config));
    const reply = (data, status = 200, headers = {}) => {
        const response = { data, status, statusText: String(status), headers, config, request: {} };
        if (status >= 400) { const e = new Error(`Request failed with status code ${status}`); e.response = response; e.config = config; throw e; }
        return response;
    };
    const q = url.searchParams, h = url.hostname;
    if (h === 'v3-cinemeta.strem.io') cinemetaCalls++;
    if (h === 'v3-cinemeta.strem.io') return reply({ meta: url.pathname.includes(SERIES) ? { name: 'Show Name', year: '2021–' } : url.pathname.includes(MAYDAY) ? { name: 'Mayday', year: '2026' } : { name: 'Ghosts of Mars', year: 2001 } });
    if (h === 'api.regielive.ro' && q.get('nume') === 'Mayday') {
        rlCalls.push(q.get('an') ? `nume+an=${q.get('an')}` : 'doar nume');
        return reply(q.get('an') === '2026' ? rlResp(mayday2026) : rlResp([...mayday2026, ...maydayJunk]));
    }
    if (h === 'api.regielive.ro') return reply(q.get('nume') === 'Show Name' ? rlSeries : rlMovie);
    if (h === 'www.titrari.ro' && url.pathname === '/index.php') {
        const z5 = q.get('z5'), z2 = q.get('z2');
        const html = (z5 === '1234567' || z2 === 'Show Name') ? titrariSeries : (z5 === '0228333' || z2 === 'Ghosts of Mars') ? titrariMovie : '';
        return reply(`<html><table>${html}</table></html>`);
    }
    if (h === 'www.subtitrari-noi.ro') return reply('<html></html>');
    if (h === 'api.subs.ro') return reply(url.pathname.includes(`/imdbid/${SERIES}`) ? subsroSeries : { count: 0, items: [] });
    if (h === 'subtitrari.regielive.ro' && url.pathname === '/descarca-pack.zip') return reply(seasonPack, 200, { 'content-type': 'application/zip' });
    if (h === 'subtitrari.regielive.ro' && archives[url.pathname]) return reply(archives[url.pathname], 200, { 'content-type': 'application/zip' });
  if (h === 'subtitrari.regielive.ro' && url.pathname === '/descarca-mdvd.zip') return reply(Buffer.from(microDvdPal), 200, { 'content-type': 'application/octet-stream' });
    return reply('not found', 404);
};


let server, base;
const get = (p) => new Promise((res, rej) => http.get(base + p, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res({ status: r.statusCode, body: b }));
}).on('error', rej));
const titles = async (p) => JSON.parse((await get(p)).body).subtitles.map(s => s.title);
const firstCue = (r) => { const m = r.body.match(/-->[^\n]*\n([^\n]+)/); return r.status === 200 ? (m ? m[1] : '') : `HTTP ${r.status}`; };
const arch = async (name, season, episode) => firstCue(await get(`/download.vtt?url=${encodeURIComponent('https://subtitrari.regielive.ro' + name)}&source=regielive&vf=&season=${season}&episode=${episode}`));

const quiet = {};
before(async () => {
    for (const k of ['log', 'error', 'warn']) { quiet[k] = console[k]; console[k] = () => {}; }
    const app = require('../server.js');
    await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); Object.assign(console, quiet); });

const vfS = 'Show.Name.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv';

test('serial: episodul exact de la acelasi grup e primul, HDTV la final, alte episoade excluse', async () => {
    const t = await titles(`/subtitles/series/${SERIES}:2:5/filename=${encodeURIComponent(vfS)}.json`);
    assert.match(t[0], /S02E05\.1080p\.WEB-DL.*-NTb/);
    assert.match(t[t.length - 1], /HDTV/);
    assert.ok(!t.some(x => /S02E04|S01E05/.test(x)), t.join(' | '));
});

test('film: varianta EXTENDED ajunge ultima cand video-ul nu e Extended', async () => {
    const t = await titles(`/subtitles/movie/${MOVIE}/filename=${encodeURIComponent('Ghosts.of.Mars.2001.1080p.BluRay.x264-AMIABLE.mkv')}.json`);
    assert.match(t[0], /AMIABLE/);
    assert.match(t[t.length - 1], /EXTENDED/);
    assert.ok(!t.some(x => /DVDRip/.test(x)));
});

test('Mayday 2026: doar cautarea cu an, fara subtitrari din alti ani', async () => {
    rlCalls = []; cinemetaCalls = 0;
    const t = await titles(`/subtitles/movie/${MAYDAY}/filename=${encodeURIComponent('Mayday_2026_1080p_RHS.mkv')}.json`);
    assert.deepStrictEqual(rlCalls, ['nume+an=2026']);
    // o singura cerere Cinemeta, folosita de toate cele 4 surse
    assert.strictEqual(cinemetaCalls, 1);
    assert.ok(t.length > 0 && t.every(x => /2026/.test(x)), t.join(' | '));
    assert.match(t[0], /1080p\.ATVP\.WEB-DL/);
});

test('pachet de sezon: se extrage episodul cerut, cu sau fara filename', async () => {
    const pack = encodeURIComponent('https://subtitrari.regielive.ro/descarca-pack.zip');
    assert.strictEqual(firstCue(await get(`/download.vtt?url=${pack}&source=regielive&vf=${encodeURIComponent(vfS)}&season=2&episode=5`)), 'EPISODUL 5');
    assert.strictEqual(firstCue(await get(`/download.vtt?url=${pack}&source=regielive&vf=&season=2&episode=5`)), 'EPISODUL 5');
    assert.strictEqual(firstCue(await get(`/download.vtt?url=${pack}&source=regielive&vf=&season=2&episode=6`)), 'EPISODUL 6');
});

test('SRT: numerele din text nu sunt sterse ca index', async () => {
    const r = await get(`/download.vtt?url=${encodeURIComponent('https://subtitrari.regielive.ro/descarca-pack.zip')}&source=regielive&vf=&season=2&episode=5`);
    const cues = r.body.replace(/^WEBVTT\n\n/, '').trim().split(/\n\n/);
    assert.deepStrictEqual(cues.map(c => c.split('\n')[1]), ['EPISODUL 5', '3', '2']);
});

test('MicroDVD: header-ul {1}{1}25.000 da fps-ul, nu apare ca replica', async () => {
    const r = await get(`/download.vtt?url=${encodeURIComponent('https://subtitrari.regielive.ro/descarca-mdvd.zip')}&source=regielive&vf=movie.mkv`);
    assert.strictEqual(r.body.replace(/^WEBVTT\n\n/, '').trim(), '00:00:10.000 --> 00:00:12.000\nZece secunde la 25fps');
});

test('arhive cu mai multe sezoane/episoade: se alege exact S02E05', async () => {
    assert.strictEqual(await arch('/descarca-full.zip', 2, 5), 'S02E05');
    assert.strictEqual(await arch('/descarca-folders.zip', 2, 5), 'SEZ2-EP5');
    assert.strictEqual(await arch('/descarca-mixed.zip', 2, 5), '2x05');
    assert.strictEqual(await arch('/descarca-mixed.zip', 2, 6), 'S02EP06');
    assert.strictEqual(await arch('/descarca-nested.zip', 2, 5), 'NESTED-S02E05');
});

test('arhiva cu un singur fisier: refuzata doar daca e clar alt episod/sezon', async () => {
    assert.match(await arch('/descarca-single-wrong.zip', 2, 5), /^HTTP [45]/);
    assert.match(await arch('/descarca-single-otherseason.zip', 2, 5), /^HTTP [45]/);
    assert.strictEqual(await arch('/descarca-single-generic.zip', 2, 5), 'SINGLE-GENERIC');
});
