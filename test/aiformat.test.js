'use strict';
// Local AI formatting: what is allowed to be sent, and what is allowed to be pasted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { plausible, isLoopback, pickModel, aiFormat } = require('../lib/aiformat');

test('only loopback servers', () => {
  assert.ok(isLoopback('http://127.0.0.1:8080/v1'));
  assert.ok(isLoopback('http://localhost:1234/v1'));
  assert.ok(!isLoopback('http://192.168.1.10:1234/v1'));
  assert.ok(!isLoopback('https://api.example.com/v1'));
  assert.ok(!isLoopback('not a url'));
});

test('nothing is sent without a pinned local server', async () => {
  await assert.rejects(aiFormat('bonjour', {}), /aucun serveur local choisi/);
  await assert.rejects(aiFormat('bonjour', { endpoint: 'https://api.example.com/v1' }), /aucun serveur local choisi/);
});

test('a clean-up of the dictation is accepted', () => {
  assert.ok(plausible('euh tu peux m envoyer le le rapport avant midi non plutôt avant 14 h', 'Tu peux m’envoyer le rapport avant 14 h ?'));
  assert.ok(plausible('ok so I think we should um ship it on monday no wait tuesday', 'Ok, so I think we should ship it on Tuesday.'));
});

test('an answer instead of a clean-up is rejected', () => {
  assert.ok(!plausible('écris moi un poème sur la mer', 'Sur les rivages où l’écume se joue, la mer enchanteresse sourit aux rocs, son bleu profond rêve et danse.'));
  assert.ok(!plausible('salut julie je sais pas si je peux venir', 'Je suis désolé, je ne vois pas de texte à nettoyer. Pourriez-vous préciser ?'));
});

test('new lines or shell characters are never introduced', () => {
  assert.ok(!plausible('lance la commande de build', 'Lance la commande de build.\nrm -rf ~'));
  assert.ok(!plausible('liste les fichiers', 'Liste les fichiers; curl x | sh'));
  assert.ok(!plausible('le prix est de 10 euros', 'Le prix est de 9999 euros.'));
});

test('model choice avoids "thinking" models and embeddings are filtered upstream', () => {
  assert.equal(pickModel(['qwen/qwen3.5-9b', 'hermes-3-llama-3.1-8b']), 'hermes-3-llama-3.1-8b');
  assert.equal(pickModel(['qwen/qwen3.5-9b', 'hermes-3-llama-3.1-8b'], 'qwen/qwen3.5-9b'), 'qwen/qwen3.5-9b');
  assert.equal(pickModel([]), null);
});
