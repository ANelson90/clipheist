import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

load('assets/js/ai/analyze.js');
const { CHAI } = globalThis;

function syntheticFeatures() {
  const F = CHAI.createFeatures(60);
  F.hasAudio = F.hasVideo = true;
  const bursts = [[10, 14], [31, 35], [48, 52]];
  const inBurst = (t) => bursts.some(([a, b]) => t >= a && t < b);
  for (let i = 0; i < F.n; i++) {
    const t = i * F.step, hot = inBurst(t);
    F.rms[i] = hot ? 0.5 + 0.1 * Math.sin(i) : 0.02;
    F.sharp[i] = hot && i % 7 === 0 ? 0.6 : (hot ? 0.2 : 0.01);
    F.motion[i] = hot ? 40 + (i % 5) : 1;
    F.luma[i] = 100; F.sat[i] = 0.4;
    F.cx[i] = hot ? 0.8 : 0.5; F.cxw[i] = hot ? 30 : 1;
  }
  return { F, bursts };
}

for (const style of ['hype', 'funny', 'cinematic', 'chill']) {
  test(`picks land on the action bursts without overlapping (${style})`, () => {
    const { F, bursts } = syntheticFeatures();
    const sc = CHAI.score(F, style);
    const picks = CHAI.pick(F, sc, { style, target: 30, speed: 1, order: 'chrono' });
    assert.ok(picks.length >= 1);
    const sorted = picks.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end - 1e-9, 'no overlap');
    if (style === 'hype' || style === 'funny') {
      for (const p of picks) assert.ok(bursts.some(([a, b]) => p.peak >= a - 1 && p.peak <= b + 1), `peak ${p.peak} is in a burst`);
    }
    for (const p of picks) assert.ok(p.start >= 0 && p.end <= 60 && p.end > p.start);
  });
}

test('hook ordering puts the strongest moment first', () => {
  const { F } = syntheticFeatures();
  const sc = CHAI.score(F, 'hype');
  const picks = CHAI.pick(F, sc, { style: 'hype', target: 30, speed: 1, order: 'hook' });
  assert.equal(picks[0].score, Math.max(...picks.map((p) => p.score)));
});

test('resolveOverlaps shifts later clips so footage never repeats', () => {
  const out = CHAI.resolveOverlaps([{ start: 0, end: 4 }, { start: 3, end: 7 }, { start: 6.5, end: 9 }], 60, 0.5);
  assert.deepEqual(out.map((p) => [p.start, p.end]), [[0, 4], [4, 8], [8, 10.5]]);
});

test('detectBeats finds 120 BPM in a synthetic click track', () => {
  const sr = 48000, secs = 20, data = new Float32Array(sr * secs);
  for (let i = 0; i < data.length; i++) {
    const t = i / sr, ph = t % 0.5;
    data[i] = 0.9 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-25 * ph);
  }
  const buf = { sampleRate: sr, length: data.length, numberOfChannels: 1, getChannelData: () => data };
  const beat = CHAI.detectBeats(buf);
  assert.ok(Math.abs(beat.bpm - 120) < 2.5, `bpm ${beat.bpm}`);
});

test('action track follows motion and stays within frame', () => {
  const { F } = syntheticFeatures();
  const tr = CHAI.buildTrack(F);
  for (const x of tr.x) assert.ok(x >= 0 && x <= 1);
  assert.ok(CHAI.trackAt(tr, 12.5) > 0.6, 'pans toward the action during a burst');
});

test('local writer returns complete post copy', () => {
  const w = CHAI.localWriteup('hype', true, [{ reasons: ['Impact spike'] }], 'clip.mp4');
  assert.ok(w.title && w.description && w.hook);
  assert.ok(w.hashtags.includes('shorts'));
});
