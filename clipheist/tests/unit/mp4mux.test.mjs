import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fixture } from './_load.mjs';

load('assets/js/media/demux.js');
load('assets/js/media/mp4mux.js');
const { CHDemux, CHMp4Mux } = globalThis;

function chunk(bytes, type, timestamp, duration) {
  return { byteLength: bytes.length, type, timestamp, duration, copyTo: (dst) => dst.set(bytes) };
}

test('round-trip: muxed MP4 has a constant 59.94 fps timeline and interleaved AAC audio', async () => {
  // borrow a real avcC so the file is a valid H.264 track description
  const src = await CHDemux.open(await fixture('bframes2997.mp4'));
  const avcC = src.video.description;
  const mux = new CHMp4Mux({ width: 1280, height: 720, fpsNum: 60000, fpsDen: 1001, audio: { codec: 'aac', sampleRate: 48000, channels: 2 } });
  const N = 120, frameUs = 1e6 * 1001 / 60000;
  for (let k = 0; k < N; k++) {
    const data = new Uint8Array(200 + (k % 7)).fill(k & 255);
    mux.addVideo(chunk(data, k % 60 === 0 ? 'key' : 'delta', Math.round(k * frameUs), Math.round(frameUs)), k === 0 ? { decoderConfig: { description: avcC } } : undefined);
  }
  const aFrames = Math.ceil((N * frameUs / 1e6) * 48000 / 1024);
  for (let i = 0; i < aFrames; i++) {
    mux.addAudio(chunk(new Uint8Array(64).fill(i & 255), 'key', Math.round(i * 1024 * 1e6 / 48000), Math.round(1024 * 1e6 / 48000)), i === 0 ? { decoderConfig: { description: new Uint8Array([0x11, 0x90]) } } : undefined);
  }
  const blob = mux.finalize();
  assert.equal(blob.type, 'video/mp4');
  const d = await CHDemux.open(blob);
  assert.equal(d.video.samples.length, N);
  assert.deepEqual([d.video.fpsInfo.rational.num, d.video.fpsInfo.rational.den], [60000, 1001]);
  const pts = d.video.samples.map((s) => s.pts);
  for (let i = 1; i < N; i++) assert.ok(Math.abs(pts[i] - pts[i - 1] - 1001 / 60000) < 1e-9, 'exact constant frame duration');
  assert.equal(d.video.samples.filter((s) => s.key).length, 2);
  assert.equal(d.video.width, 1280);
  assert.equal(d.audio.samples.length, aFrames);
  assert.equal(d.audio.codec, 'mp4a.40.2');
  // payloads survive the round trip
  const buf = new Uint8Array(await blob.arrayBuffer());
  const s7 = d.video.samples[7];
  assert.equal(buf[s7.offset], 7);
  assert.equal(s7.size, 200);
});

test('muxer refuses to finalize without video', () => {
  const mux = new CHMp4Mux({ width: 2, height: 2, fpsNum: 30, fpsDen: 1, audio: null });
  assert.throws(() => mux.finalize(), /No video frames/);
});
