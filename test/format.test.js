'use strict';
// Rule-based formatting: vocabulary, snippets, typography, fillers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatText, countWords } = require('../lib/format');
const { DEFAULT_VOCAB, applyVocabulary, normalizeVocab } = require('../lib/vocab');

const fr = (t, extra = {}) => formatText(t, { language: 'fr', dictionary: DEFAULT_VOCAB, ...extra });

test('vocabulary: what the model hears becomes the word you meant', () => {
  assert.equal(fr("euh j'automatise tout avec N huit N et x field, puis je poste sur tic toc avec post iz"),
    "J'automatise tout avec n8n et Higgsfield, puis je poste sur TikTok avec Postiz");
});

test('vocabulary: longest match first, exact casing kept at sentence start', () => {
  assert.equal(applyVocabulary('clode code et clode', DEFAULT_VOCAB), 'Claude Code et Claude');
  assert.equal(fr('n huit n est génial.'), 'n8n est génial.');
});

test('French typography: thin no-break space before ? ! ; : but not in times', () => {
  const out = fr('tu viens demain? oui, à 10:30');
  assert.equal(out, 'Tu viens demain ? Oui, à 10:30');
});

test('English keeps no space before punctuation', () => {
  assert.equal(formatText('um so I use chat gpt and git hub ?', { language: 'en', dictionary: DEFAULT_VOCAB }), 'So I use ChatGPT and GitHub?');
});

test('snippets: a trigger phrase expands', () => {
  assert.equal(fr('voici ma signature', { snippets: [{ trigger: 'ma signature', expansion: 'Bonne journée !' }] }), 'Voici Bonne journée\u202f!');   // French thin space before !
});

test('empty and filler-only input give an empty string', () => {
  assert.equal(formatText(''), '');
  assert.equal(fr('euh'), '');
});

test('word count handles apostrophes and hyphens', () => {
  assert.equal(countWords("aujourd'hui c'est peut-être bien"), 4);
});

test('normalizeVocab: legacy string list, duplicates, sound equal to the word', () => {
  assert.deepEqual(normalizeVocab(['n8n', 'N8N', { word: 'Opus', sounds: ['opus', 'o pus'] }]), [
    { word: 'n8n', sounds: [] },
    { word: 'Opus', sounds: ['o pus'] },
  ]);
});
