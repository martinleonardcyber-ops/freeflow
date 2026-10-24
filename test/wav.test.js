'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pcm16ToWav, wavDurationMs } = require('../lib/wav');

test('PCM16 -> WAV header and duration', () => {
  const wav = pcm16ToWav(Buffer.alloc(16000 * 2 * 3), 16000, 1);   // 3 s of silence
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wavDurationMs(wav), 3000);
  assert.equal(wavDurationMs(Buffer.alloc(10)), 0);
});
