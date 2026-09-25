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
