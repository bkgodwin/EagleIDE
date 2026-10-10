const test = require('node:test');
const assert = require('node:assert/strict');
const autocomplete = require('../static/js/autocomplete.js');
test('autocomplete refuses the beginning and middle of existing identifiers', () => {
  for (const word of ['name', 'person.name', 'import datetime', 'from math import sqrt', '$count']) {
    const start = word.lastIndexOf(' ') + 1;
    for (let ch = start; ch < word.length; ch++) if (/[\w$]/.test(word[ch])) assert.equal(autocomplete.contextAt(word, ch), null, `${word} at ${ch}`);
    assert.ok(autocomplete.contextAt(word, word.length));
  }
  assert.ok(autocomplete.contextAt('person.', 7));
  assert.ok(autocomplete.contextAt('na ', 2));
});
