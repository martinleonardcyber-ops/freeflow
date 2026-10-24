'use strict';
// Light, deterministic formatting pass. Wispr Flow runs an LLM "Formatting"
// step in the cloud; OxoFlow keeps it local and rule-based:
//  - strip fillers (fr: euh/hum/hmm, en: um/uh/erm), collapse repeated "like"/"genre"
//  - apply snippets (trigger phrase -> expansion), then the vocabulary
//    ("what the model heard" -> "the word you meant", see vocab.js)
//  - punctuation spacing (French typographic spaces before ? ! ; :)
//  - capitalise sentence starts, collapse whitespace

const FILLERS = ['euh+', 'heu+', 'hum+', 'hmm+', 'mmh+', 'um+', 'uh+', 'uhm', 'erm', 'mh+'];
const REPEATED = ['like', 'genre', 'voilà', 'du coup', 'you know', 'tu vois'];
const NNBSP = ' '; // narrow no-break space (French typography)
const NBSP = ' ';
const { protectVocabulary, PH_OPEN, PH_CLOSE } = require('./vocab');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Unicode-aware "whole word" wrapper (JS \b is ASCII-only, breaks on é/à/ç).
function word(re) {
  return `(?<![\\p{L}\\p{N}])(?:${re})(?![\\p{L}\\p{N}])`;
}

function stripFillers(text) {
  const re = new RegExp(`\\s*,?\\s*${word(FILLERS.join('|'))}[,]?`, 'giu');
  let out = text.replace(re, ' ');
  // Repeated discourse markers: "genre genre" / "like, like" -> single
  for (const w of REPEATED) {
    const r = new RegExp(`${word(escapeRe(w))}(?:\\s*,?\\s+${escapeRe(w)}(?![\\p{L}\\p{N}]))+`, 'giu');
    out = out.replace(r, w);
  }
  return out;
}

function applySnippets(text, snippets) {
  let out = text;
  for (const s of snippets || []) {
    if (!s || !s.trigger || !s.trigger.trim()) continue;
    const trig = s.trigger.trim().split(/\s+/).map(escapeRe).join('\\s+');
    const re = new RegExp(word(trig), 'giu');
    out = out.replace(re, s.expansion || '');
  }
  return out;
}

function fixPunctuation(text, language) {
  let out = text;
  out = out.replace(/\s+([,.)\]}…])/g, '$1');            // no space before , . ) ]
  out = out.replace(/([(\[{])\s+/g, '$1');                  // no space after ( [
  out = out.replace(new RegExp(String.raw`,(?=[\p{L}${PH_OPEN}])`, 'gu'), ', '); // space after comma before a letter or a protected word
  out = out.replace(/([.!?…])(?=\p{Lu})/gu, '$1 ');        // space after sentence end
  out = out.replace(/,\s*,/g, ',').replace(/\.\s*,/g, '.').replace(/,\s*\./g, '.');
  if (language === 'fr') {
    // French: thin no-break space before high punctuation, except in times (10:30) and URLs.
    out = out.replace(new RegExp(String.raw`(?<=[\p{L}\p{N}»)\]${PH_CLOSE}])[   ]*([?!;:])(?![\p{N}/])`, 'gu'), `${NNBSP}$1`);
    out = out.replace(/«[   ]*/g, `«${NBSP}`).replace(/[   ]*»/g, `${NBSP}»`);
  } else {
    out = out.replace(/\s+([?!;:])/g, '$1');
  }
  return out;
}

function capitalise(text) {
  return text.replace(/(^|[.!?…]["»”]?\s+)(\p{Ll})/gu, (m, pre, ch) => pre + ch.toUpperCase());
}

function countWords(text) {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
}

/**
 * @param {string} raw transcript from the STT engine
 * @param {{language?:string, snippets?:Array<{trigger:string,expansion:string}>, dictionary?:Array<string|{word:string,sounds:string[]}>}} opts
 */
function formatText(raw, opts = {}) {
  if (!raw) return '';
  const lang = (opts.language || 'fr').slice(0, 2).toLowerCase();
  let t = String(raw).replace(/\s+/g, ' ').trim();
  t = stripFillers(t);
  // "euh" heard as the letter E right after punctuation ("…locale. E, le modèle…"); a real "E" after a word is kept.
  if (lang === 'fr') t = t.replace(/(^|[.!?,;]\s)E,\s/g, '$1');
  t = t.replace(/^[\s,.;:!?]+/, '');                        // leading punctuation left by a removed filler
  t = applySnippets(t, opts.snippets);
  const vocab = protectVocabulary(t, opts.dictionary);    // n huit n -> n8n, x field -> Higgsfield...
  t = vocab.text;
  t = fixPunctuation(t, lang);
  t = t.replace(/\s{2,}/g, ' ').trim();
  t = capitalise(t);                                       // protected words keep their exact casing
  return vocab.restore(t);
}

module.exports = { formatText, countWords, stripFillers, applySnippets, fixPunctuation, capitalise };
