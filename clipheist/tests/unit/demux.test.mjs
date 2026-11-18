import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fixture } from './_load.mjs';

load('assets/js/media/demux.js');
const { CHDemux } = globalThis;

test('WebM (VP9/Opus, 59.94 fps): codec, frame count and exact frame rate', async () => {
  const d = await CHDemux.open(await fixture('cfr5994.webm'));
  assert.equal(d.container, 'mkv');
  assert.match(d.video.codec, /^vp09\./);
  assert.ok(Math.abs(d.video.samples.length - 7 * 60000 / 1001) <= 2, 'about 420 frames');
  assert.deepEqual([d.video.fpsInfo.rational.num, d.video.fpsInfo.rational.den], [60000, 1001]);
  assert.equal(d.video.fpsInfo.vfr, false);
  assert.equal(d.audio.codec, 'opus');
  assert.ok(d.audio.description && d.audio.description.length >= 19, 'OpusHead present');
});

test('MP4 (H.264 with B-frames + AAC, 29.97 fps): sample tables, reordering and keyframes', async () => {
  const d = await CHDemux.open(await fixture('bframes2997.mp4'));
  assert.equal(d.container, 'mp4');
  assert.match(d.video.codec, /^avc1\.[0-9A-F]{6}$/);
  assert.deepEqual([d.video.fpsInfo.rational.num, d.video.fpsInfo.rational.den], [30000, 1001]);
  const s = d.video.samples;
  assert.ok(s[0].key, 'first sample is a keyframe');
  assert.ok(s.some((x, i) => i > 0 && x.pts < s[i - 1].pts), 'B-frames: decode order differs from presentation order');
  assert.ok(Math.abs(Math.min(...s.map((x) => x.pts))) < 0.01, 'edit list maps first frame to t=0');
  assert.match(d.audio.codec, /^mp4a\.40\.\d+$/);
  assert.equal(d.audio.sampleRate, 44100);
});

test('Long MP4 with audio: duration and sample offsets are inside the file', async () => {
  const blob = await fixture('action.mp4');
  const d = await CHDemux.open(blob);
  assert.ok(Math.abs(d.duration - 60) < 0.2);
  for (const t of [d.video, d.audio]) for (const s of t.samples) assert.ok(s.offset + s.size <= blob.size);
});
