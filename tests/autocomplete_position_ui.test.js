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

test('completion flips above a low caret and stays inside the visual viewport', () => {
  for (const viewport of [{width:1000,height:800}, {width:390,height:340,offsetTop:220,offsetLeft:10}]) {
    const bottom = (viewport.offsetTop || 0) + viewport.height;
    const coords = {left:viewport.width-25,top:bottom-40,bottom:bottom-20};
    const p = autocomplete.popupPlacement(coords,{width:600,height:340},viewport);
    assert.equal(p.up,true);
    assert.ok(p.top >= (viewport.offsetTop || 0) + 8);
    assert.ok(p.top + p.height <= coords.top - 3);
    assert.ok(p.left >= (viewport.offsetLeft || 0) + 8);
    assert.ok(p.left + p.width <= (viewport.offsetLeft || 0) + viewport.width - 8);
  }
  const down = autocomplete.popupPlacement({left:10,top:15,bottom:35},{width:250,height:300},{width:800,height:600});
  assert.equal(down.up,false); assert.equal(down.top,38);
  const small = autocomplete.popupPlacement({left:12,top:70,bottom:90},{width:600,height:900},{width:250,height:160});
  assert.ok(small.height < 900); assert.ok(small.top + small.height <= 152);
});
