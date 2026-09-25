// test/scorer.test.js — ruleaza cu `npm test` (node:test, fara dependinte)
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateScore, getSourceType } = require('../lib/scorer');

// Reproduce filtrarea + sortarea din addon.js: "low" si wrongSeason/wrongEpisode
// sunt eliminate complet, restul sortat dupa scor.
function rank(titles, videoFilename, { season = null, episode = null, signals = {} } = {}) {
    return titles
        .filter(t => getSourceType(t) !== 'low')
        .map(t => ({ t, ...calculateScore(t, videoFilename.toLowerCase(), signals[t] || null, getSourceType(videoFilename.toLowerCase()), season, episode) }))
        .filter(s => !s.breakdown.wrongSeason && !s.breakdown.wrongEpisode)
        .sort((a, b) => b.score - a.score)
        .map(s => s.t);
}

test('sursa: cuvintele din titlu nu mai sunt confundate cu taguri de release', () => {
    for (const title of [
        'Ghosts of Mars (2001)',               // "ts"
        'Fantastic Beasts The Secrets of Dumbledore',
        'Watchmen 2009 Directors Cut',         // "tc"
        'The Witcher Sezonul 1',
        'Sincronizat cam pe toate versiunile', // romanescul "cam"
        'Movie 2010 720p DTS x264',            // DTS audio
        'Inferno 2016 1080p',                  // "nf"
        'Abduction 2011 720p',                 // "bd"
    ]) {
        assert.equal(getSourceType(title), null, title);
    }
});

test('sursa: tagurile reale sunt recunoscute, inclusiv formele lipite', () => {
    const cases = {
        'Movie.2010.1080p.BluRay.x264-SPARKS': 'disc',
        'Movie.2010.2160p.UHD.BluRay.REMUX': 'disc',
        'Movie.2010.720p.BDRip': 'disc',
        'Movie.2010.BluRay1080p': 'disc',
        'Movie.2010.720pBluRay.x264': 'disc',
        'Show.S01E01.1080p.NF.WEB-DL.DDP5.1': 'web',
        'Show.S01E01.1080p.WEB.DL': 'web',
        'Movie 2019 WEBRip': 'web',
        'Movie [WEB-DL]': 'web',
        'Unforgiven.1992.1080p.HDTV': 'hdtv',
        'Movie.2010.720p.HDTVRip': 'hdtv',
        'Movie.2023.TS.XviD': 'low',
        'Movie.2023.HD-TS': 'low',
        'Movie.2023.HDCAM': 'low',
        'Movie CAMRip': 'low',
        'Movie 2005 DVDRip XviD': 'low',
    };
    for (const [title, expected] of Object.entries(cases)) {
        assert.equal(getSourceType(title), expected, title);
    }
});

test('episod: formatele NxM (inclusiv cu zero in fata) sunt potriviri exacte', () => {
    for (const title of ['Show 1x05 720p', 'Show 01x05', 'Show.S01.E05.720p', 'Show.S1E5', 'Show.S01E04E05.720p', 'Show Sezonul 1 Episodul 5']) {
        const { breakdown } = calculateScore(title, '', null, null, 1, 5);
        assert.match(breakdown.seEpisode, /^S01E05\(\+80\)/, title);
    }
});

test('episod: alt episod explicit din acelasi sezon e exclus', () => {
    for (const title of ['Show.S01E02.720p.WEB-DL', 'Show 1x02', 'Sezonul 1 Episodul 3', 'Show.S01E06-E08']) {
        const { breakdown } = calculateScore(title, '', null, null, 1, 5);
        assert.equal(breakdown.wrongEpisode, true, title);
    }
});

test('episod: intervalele care contin episodul sunt pachete, nu excluderi', () => {
    for (const title of ['Show.S01E01-E10', 'Show S01E01-S01E10', 'Show S01E01-10 complet']) {
        const { breakdown } = calculateScore(title, '', null, null, 1, 5);
        assert.equal(breakdown.wrongEpisode, undefined, title);
        assert.match(breakdown.seEpisode, /pachet/, title);
    }
    // "S01E05 - 1080p" nu e un interval de episoade
    const { breakdown } = calculateScore('Show.S01E05 - 1080p', '', null, null, 1, 5);
    assert.match(breakdown.seEpisode, /^S01E05\(\+80\)/);
});

test('episod: listele de episoade sunt citite complet', () => {
    for (const title of ['Sezonul 1 episoadele 1, 2, 3, 4, 5', 'Show S01E01, E02, E05', 'Show S01E01 si E05']) {
        const { breakdown } = calculateScore(title, '', null, null, 1, 5);
        assert.equal(breakdown.wrongEpisode, undefined, title);
    }
    assert.equal(calculateScore('Sezonul 1 episoadele 1-4 si 6-10', '', null, null, 1, 5).breakdown.wrongEpisode, true);
    // un titlu care se declara pachet nu e exclus doar pt. ca numeste un episod
    assert.equal(calculateScore('Show S01E01 pachet complet sezonul 1', '', null, null, 1, 5).breakdown.wrongEpisode, undefined);
});

test('sezon: pachetele multi-sezon care acopera sezonul nu mai sunt excluse', () => {
    for (const title of ['Show Seasons 1-5 complete', 'Show S01-S05 pack', 'Show Sezoanele 1 - 5']) {
        const { breakdown } = calculateScore(title, '', null, null, 3, 2);
        assert.equal(breakdown.wrongSeason, undefined, title);
        assert.match(breakdown.seEpisode, /multi-sezon/, title);
    }
    const outside = calculateScore('Show S01-S02 pack', '', null, null, 3, 2);
    assert.equal(outside.breakdown.wrongSeason, true);
});

test('sezon: filename cu rezolutie "1920x1080" nu e citit ca sezon/episod', () => {
    const { breakdown } = calculateScore('Movie 2010 1080p BluRay', 'movie.2010.1920x1080.bluray.mkv', null);
    assert.equal(breakdown.seEpisode, undefined);
});

test('versiune: video fara tag prefera subtitrarea fara tag, chiar cu rating mai mic', () => {
    const video = 'Movie.2009.1080p.BluRay.x264-GRP.mkv';
    const extended = 'Movie.2009.EXTENDED.1080p.BluRay.x264-AAA';
    const plain = 'Movie.2009.1080p.BluRay.x264-BBB';
    const order = rank([extended, plain], video, { signals: { [extended]: { type: 'rating', value: 9.5 }, [plain]: { type: 'rating', value: 4 } } });
    assert.equal(order[0], plain);
});

test('versiune: theatrical vs extended e penalizat la fel ca invers (-70)', () => {
    const a = calculateScore('Movie.2009.EXTENDED.1080p.BluRay', 'movie.2009.theatrical.1080p.bluray.mkv', null);
    const b = calculateScore('Movie.2009.THEATRICAL.1080p.BluRay', 'movie.2009.extended.1080p.bluray.mkv', null);
    assert.match(a.breakdown.sourceMatch, /\(-70\)/);
    assert.match(b.breakdown.sourceMatch, /\(-70\)/);
});

test('versiune: orice versiune comuna conteaza ca potrivire', () => {
    const { breakdown } = calculateScore('Movie.2009.UNRATED.1080p.BluRay', 'movie.2009.directors.cut.unrated.1080p.bluray.mkv', null);
    assert.match(breakdown.sourceMatch, /UNRATED match\(\+40\)/);
});

test('grup: recunoscut si cu [tag] sau sufix de limba dupa el', () => {
    assert.match(calculateScore('Movie.2010.1080p.BluRay.x264-SPARKS', 'movie.2010.1080p.bluray.x264-sparks[rarbg].mkv', null).breakdown.matchedGroup, /^sparks/);
    assert.match(calculateScore('Movie.2010.1080p.BluRay.x264-SPARKS-RO', 'movie.2010.1080p.bluray.x264-sparks.mkv', null).breakdown.matchedGroup, /^sparks/);
    // un titlu cu cratima nu devine "grup"
    assert.equal(calculateScore('Spider-Man.2002.WEB-DL', 'spider-man.2002.1080p.web-dl.mkv', null).breakdown.matchedGroup, undefined);
});

test('clasament serial: episodul exact castiga, episoadele gresite dispar', () => {
    const video = 'Show.Name.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv';
    const titles = [
        'Show.Name.S02E05.720p.HDTV.x264-KILLERS',
        'Show.Name.S02E04.1080p.WEB-DL.DDP5.1.H.264-NTb',
        'Show Name Sezonul 2 complet 1080p WEB-DL',
        'Show.Name.S01E05.1080p.WEB-DL-NTb',
        'Show.Name.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb',
        'Show Name S02E05 - Secrets and Lies',
    ];
    const order = rank(titles, video, { season: 2, episode: 5 });
    assert.equal(order[0], 'Show.Name.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb');
    assert.ok(!order.includes('Show.Name.S02E04.1080p.WEB-DL.DDP5.1.H.264-NTb'));
    assert.ok(!order.includes('Show.Name.S01E05.1080p.WEB-DL-NTb'));
    assert.ok(order.includes('Show Name S02E05 - Secrets and Lies'));
});

test('clasament film: titlul filmului nu mai elimina candidatii', () => {
    const video = 'Ghosts.of.Mars.2001.1080p.BluRay.x264-AMIABLE.mkv';
    const titles = [
        'Ghosts of Mars (2001) - traducere completa',
        'Ghosts.of.Mars.2001.1080p.BluRay.x264-AMIABLE',
        'Ghosts of Mars 2001 DVDRip XviD',
    ];
    const order = rank(titles, video);
    assert.deepEqual(order, ['Ghosts.of.Mars.2001.1080p.BluRay.x264-AMIABLE', 'Ghosts of Mars (2001) - traducere completa']);
});

test('versiune: taietura diferita e marcata (cutMismatch) si ajunge la final', () => {
    const plainVideo = 'movie.2009.1080p.bluray.x264-yts.mkv';
    assert.equal(calculateScore('Movie.2009.EXTENDED.1080p.BluRay', plainVideo, null).breakdown.cutMismatch, true);
    assert.equal(calculateScore('Movie.2009.1080p.WEB-DL', plainVideo, null).breakdown.cutMismatch, undefined);
    assert.equal(calculateScore('Movie.2009.Theatrical.1080p', plainVideo, null).breakdown.cutMismatch, undefined);
    // video EXTENDED: subtitrarea fara tag e varianta de cinema
    assert.equal(calculateScore('Movie.2009.1080p.BluRay', 'movie.2009.extended.1080p.bluray.mkv', null).breakdown.cutMismatch, true);
    assert.equal(calculateScore('Movie.2009.Extended.1080p', 'movie.2009.extended.1080p.bluray.mkv', null).breakdown.cutMismatch, undefined);
    // fara filename: presupunem varianta de cinema
    assert.equal(calculateScore('Movie 2009 Directors Cut', '', null).breakdown.cutMismatch, true);
});

test('episod: formate romanesti si variante suplimentare', () => {
    for (const title of ['Sezon 1 Episod 5', 'Sez. 1 Ep. 5', 'Show S01 Ep05', 'Show S01EP05', 'Episodul 5 din sezonul 1', 'Sezonul 1/Episodul 05']) {
        assert.match(calculateScore(title, '', null, null, 1, 5).breakdown.seEpisode, /^S01E05\(\+80\)/, title);
    }
    assert.equal(calculateScore('Show Sez. 3 Ep. 5', '', null, null, 1, 5).breakdown.wrongSeason, true);
});

test('an: anul din Cinemeta, inclusiv cu "_" ca separator in filename', () => {
    assert.equal(calculateScore('Mayday.2026.1080p.WEB-DL', 'mayday_2026_1080p_rhs.mkv', null).breakdown.year, '2026(+30)');
    assert.equal(calculateScore('Blade Runner 2049 (2017) 1080p', 'blade.runner.2049.2017.1080p.mkv', null).breakdown.year, '2017(+30)');
    assert.equal(calculateScore('Mayday.2026.WEB', '', null, null, null, null, false, { knownYear: 2026 }).breakdown.year, '2026(+30)');
});

test('an: film cu acelasi nume din alt an / episod de serial e exclus la sursele cautate dupa text', () => {
    const ctx = { contentType: 'movie', knownYear: 2026, titleName: 'Mayday', checkYear: true };
    const video = 'mayday_2026_1080p_rhs.mkv';
    assert.ok(calculateScore('Mayday 2021 1080p Bluray DTS-HD MA 5 1 X264-EVO', video, null, null, null, null, false, ctx).breakdown.wrongYear);
    assert.ok(calculateScore('mayday.1x01.720p_hdtv_x264-fov', video, null, null, null, null, false, ctx).breakdown.wrongType);
    assert.equal(calculateScore('Mayday.2026.1080p.ATVP.WEB-DL', video, null, null, null, null, false, ctx).breakdown.wrongYear, undefined);
    assert.equal(calculateScore('Mayday.2025.1080p.WEB-DL', video, null, null, null, null, false, ctx).breakdown.wrongYear, undefined); // +-1 an
    // sursele filtrate pe IMDb (checkYear false) nu sunt afectate
    assert.equal(calculateScore('Mayday 2021', video, null, null, null, null, false, { ...ctx, checkYear: false }).breakdown.wrongYear, undefined);
    // un an care face parte din titlul filmului nu e "alt an"
    const br = { contentType: 'movie', knownYear: 2017, titleName: 'Blade Runner 2049', checkYear: true };
    assert.equal(calculateScore('Blade.Runner.2049.2017.1080p.BluRay', '', null, null, null, null, false, br).breakdown.wrongYear, undefined);
    // "4x4" din titlu nu e un episod
    const fx = { contentType: 'movie', knownYear: 2019, titleName: '4x4', checkYear: true };
    assert.equal(calculateScore('4x4 2019 1080p WEB-DL', '', null, null, null, null, false, fx).breakdown.wrongType, undefined);
});

// Cazuri gasite la review (agent): notatii care NU trebuie sa excluda un pachet
// ce contine episodul, si titluri de episod care nu sunt intervale.
test('review: intervalele/listele in orice notatie acopera episodul cerut', () => {
    for (const title of [
        'The Bear S02E01–E10', 'The Bear S02E01 pana la S02E10', 'The Bear Sezonul 2 episoadele 1 pana la 10',
        'Season 2 Episodes 1 to 10', 'S02E01 ... E10', 'Show S01E01-S02E10', 'S02E03-E04-E05',
        'S02E04 & 05', 'S02E04 si 05', 'Sezonul 2 episodul 4/5', 'The.Bear.S02E04.&.05.1080p',
        'The.Bear.Sezonul.2.episoadele.1.la.10.1080p', 'The.Bear.2x01.-.2x10.1080p',
    ]) {
        const season = title.includes('S01E01-S02E10') ? 1 : 2;
        const { breakdown } = calculateScore(title, '', null, null, season, 5);
        assert.equal(breakdown.wrongEpisode, undefined, title);
    }
});

test('review: titlul episodului nu devine interval, anime absolut nu e exclus', () => {
    // "S03E07 - 42" (Doctor Who): ambiguu -> nici pachet E07-E42, nici exclus
    assert.match(calculateScore('Doctor.Who.S03E07 - 42', '', null, null, 3, 7).breakdown.seEpisode, /^S03E07\(\+80\)/);
    assert.equal(calculateScore('Doctor.Who.S03E07 - 42', '', null, null, 3, 10).breakdown.wrongEpisode, undefined);
    // "24 S01E01 - 12:00 A.M." e episodul 1, deci exclus pt. E05
    assert.equal(calculateScore('24.S01E01 - 12:00 A.M.-1:00 A.M.', '', null, null, 1, 5).breakdown.wrongEpisode, true);
    assert.match(calculateScore('Show.S01E05-10bit', '', null, null, 1, 5).breakdown.seEpisode, /^S01E05\(\+80\)/);
    assert.equal(calculateScore('One.Piece.S21E1071.1080p.CR.WEB-DL', '', null, null, 21, 180).breakdown.wrongEpisode, undefined);
    // "traducere completa" nu e un pachet
    assert.equal(calculateScore('The.Bear.S01E04.1080p.WEB-DL-NTb - traducere completa', '', null, null, 1, 5).breakdown.wrongEpisode, true);
    // "Season 2 - 4K" nu e intervalul de sezoane 2-4
    assert.equal(calculateScore('Show Season 2 - 4K HDR WEB-DL', '', null, null, 3, 1).breakdown.wrongSeason, true);
});

test('review: CAM/TS/TC ca tag real vs proza, codec lipit de sursa', () => {
    for (const t of ['Oppenheimer 2023 CAM x264-GRP', 'Movie 2023 TS', 'movie.2023.ts.xvid', 'Movie 2004 DVDRipXviD-DiAMOND']) assert.equal(getSourceType(t), 'low', t);
    for (const t of ['Sincronizare (cam 2 secunde mai devreme)', 'Sincro cam-asa, merge', 'Traducere: Tudor C. (TC)']) assert.equal(getSourceType(t), null, t);
    assert.equal(getSourceType('Movie.BluRayx264'), 'disc');
    assert.equal(getSourceType('Show.HDTVx264'), 'hdtv');
});

test('review: taietura — cuvinte din titlu, seriale, "Theatrical si Extended"', () => {
    // "Uncut" din titlul "Uncut Gems" nu e editie
    assert.equal(calculateScore('BluRay 1080p x264-SPARKS', 'uncut.gems.2019.1080p.bluray.x264-sparks.mkv', null, null, null, null, false, { contentType: 'movie', titleName: 'Uncut Gems' }).breakdown.cutMismatch, undefined);
    // la seriale nu aplicam regula (titlul episodului "Redux")
    assert.equal(calculateScore('The X-Files S05E01 - Redux 1080p BluRay', 'the.x-files.s05e01.1080p.bluray.mkv', null, null, 5, 1, false, { contentType: 'series' }).breakdown.cutMismatch, undefined);
    // o subtitrare cu ambele variante se potriveste si cu video fara tag
    assert.equal(calculateScore('Movie 2009 1080p BluRay - contine ambele variante: Theatrical si Extended', 'movie.2009.1080p.bluray.mkv', null).breakdown.cutMismatch, undefined);
});

test('credite de traducator nu sunt sursa TS/TC/CAM', () => {
    for (const t of ['Show S01E05 WEB-DL - Sincronizare TS', 'Film 2019 sincro TS', 'Traducere: TC', 'Film 2019 - traducere si sincronizare TS 720p']) assert.notEqual(getSourceType(t), 'low', t);
    for (const t of ['Movie 2023 TS x264', 'Film adaptata pentru TS', 'Movie 2023 HDTS']) assert.equal(getSourceType(t), 'low', t);
});

test('sezon cu cifre romane si "S2 - E5"', () => {
    assert.match(calculateScore('Show Sezonul II WEB-DL', '', null, null, 2, 5).breakdown.seEpisode, /^S02\(\+40\)/);
    assert.equal(calculateScore('Show Sezonul II WEB-DL', '', null, null, 3, 5).breakdown.wrongSeason, true);
    assert.match(calculateScore('Show Sezoanele I-III', '', null, null, 2, 5).breakdown.seEpisode, /pachet multi-sezon/);
    assert.match(calculateScore('Show S2 - E5 WEB-DL', '', null, null, 2, 5).breakdown.seEpisode, /^S02E05\(\+80\)/);
    assert.equal(calculateScore('Show S2 - E6 WEB-DL', '', null, null, 2, 5).breakdown.wrongEpisode, true);
    // cuvinte care incep cu litere "romane" nu sunt atinse
    assert.match(calculateScore('Show Season Xmas Special', '', null, null, 2, 5).breakdown.seEpisode, /^fara info/);
});

test('sezon: interval de sezoane care nu contine sezonul cerut e exclus', () => {
    for (const [title, season] of [['Show Sezoanele 1-5', 6], ['Sezoanele 2-15 complete, 305 episoade, pentru WEB-DL, BluRay.', 23], ['Show Seasons 1-3', 4]]) {
        assert.equal(calculateScore(title, '', null, null, season, 1).breakdown.wrongSeason, true, title);
    }
    // sezonul din interval ramane pachet multi-sezon, nu exclus
    assert.equal(calculateScore('Sezoanele 2-15 complete, 305 episoade', '', null, null, 6, 1).breakdown.wrongSeason, undefined);
    // "Season 2 - 4K" nu e interval
    assert.equal(calculateScore('Show Season 2 - 4K', '', null, null, 3, 1).breakdown.seEpisode.startsWith('alt sezon'), true);
});

test('episod: "Episoadele 1-22" exclude E23, dar nu si episoadele din interval', () => {
    assert.equal(calculateScore('Show Episoadele 1-22', '', null, null, 1, 23).breakdown.wrongEpisode, true);
    assert.equal(calculateScore('Show Sezonul 3 complet, episoadele 1-22', '', null, null, 3, 23).breakdown.wrongEpisode, true);
    assert.equal(calculateScore('Show Episoadele 1-22', '', null, null, 1, 5).breakdown.wrongEpisode, undefined);
    // interval care nu incepe de la 1 = posibil numerotare absoluta, nu excludem
    assert.equal(calculateScore('Show Episoadele 20-30', '', null, null, 2, 3).breakdown.wrongEpisode, undefined);
});
