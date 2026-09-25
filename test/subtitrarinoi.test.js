// test/subtitrarinoi.test.js — ruleaza cu `npm test` (node:test, fara dependinte)
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeUnsafePathChars } = require('../lib/subtitrarinoi');

test('":" dintr-un titlu (ex. "Bhoot: Part One") e codificat ca %3A in URL-ul de descarcare', () => {
    const url = 'https://www.subtitrari-noi.ro/58128-subtitrari-noi.ro-Bhoot:_Part_One_-_The_Haunted_Ship-174.zip';
    assert.equal(
        encodeUnsafePathChars(url),
        'https://www.subtitrari-noi.ro/58128-subtitrari-noi.ro-Bhoot%3A_Part_One_-_The_Haunted_Ship-174.zip'
    );
});

test('un URL fara ":" ramane neschimbat', () => {
    const url = 'https://www.subtitrari-noi.ro/1-subtitrari-noi.ro-Ghosts_of_Mars-2.zip';
    assert.equal(encodeUnsafePathChars(url), url);
});

test('schema ("https://") si portul unui host cu ":" nu sunt atinse', () => {
    const url = 'https://www.subtitrari-noi.ro:8443/1-subtitrari-noi.ro-Movie:_Subtitle-2.zip';
    assert.equal(
        encodeUnsafePathChars(url),
        'https://www.subtitrari-noi.ro:8443/1-subtitrari-noi.ro-Movie%3A_Subtitle-2.zip'
    );
});
