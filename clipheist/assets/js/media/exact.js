/*
 * ClipHeist frame-exact render engine (WebCodecs).
 *
 *  demuxed samples → VideoDecoder (every source frame, no real-time playback)
 *    → compositor callback (effects, transitions, text) at an exact output frame grid k / fps
 *    → VideoEncoder (H.264) → MP4 muxer with constant frame rate timestamps.
 *  Audio is mixed sample-accurately in an OfflineAudioContext and encoded with AudioEncoder.
 *
 * Because nothing depends on wall-clock playback, exports never drop or duplicate frames
 * because the computer was busy. A 59.94 fps source exported at "match source" contains
 * exactly one output frame per source frame.
 */
window.CHExact = (function () {
  'use strict';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function Unsupported(msg) { var e = new Error(msg); e.unsupported = true; return e; }
  function Cancelled() { var e = new Error('Cancelled'); e.cancelled = true; return e; }

  function supported() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' &&
      typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined' &&
      typeof VideoFrame !== 'undefined' && typeof AudioData !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
  }

  async function videoDecoderConfig(v) {
    if (!v || !v.codec || typeof VideoDecoder === 'undefined') return null;
    var codecs = [v.codec].concat(v.altCodecs || []);
    for (var i = 0; i < codecs.length; i++) {
      var cfg = { codec: codecs[i], codedWidth: v.width || undefined, codedHeight: v.height || undefined };
      if (v.description) cfg.description = v.description;
      try {
        var r = await VideoDecoder.isConfigSupported(cfg);
        if (r.supported) return cfg;
      } catch (e) { /* try next */ }
    }
    return null;
  }

  async function audioDecoderConfig(a) {
    if (!a || !a.codec || typeof AudioDecoder === 'undefined') return null;
    var cfg = { codec: a.codec, sampleRate: Math.round(a.sampleRate || 48000), numberOfChannels: a.channels || 2 };
    if (a.description) cfg.description = a.description;
    try {
      var r = await AudioDecoder.isConfigSupported(cfg);
      return r.supported ? cfg : null;
    } catch (e) { return null; }
  }

  // H.264 level table: [hex, max macroblocks/sec, max frame size in MBs]
  var LEVELS = [['1F', 108000, 3600], ['28', 245760, 8192], ['2A', 522240, 8704], ['32', 589824, 22080], ['33', 983040, 36864], ['34', 2073600, 36864]];
  async function pickVideoEncoder(w, h, fps, bitrate) {
    var fs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = fs * fps;
    var lv = LEVELS.filter(function (l) { return l[1] >= mbps && l[2] >= fs; });
    if (!lv.length) lv = [LEVELS[LEVELS.length - 1]];
    var profiles = ['640', '4D0', '42E'];
    for (var p = 0; p < profiles.length; p++) {
      for (var i = 0; i < lv.length; i++) {
        var codec = 'avc1.' + profiles[p].slice(0, 2) + (profiles[p] === '42E' ? 'E0' : '00') + lv[i][0];
        var cfg = { codec: codec, width: w, height: h, bitrate: Math.round(bitrate), framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality', bitrateMode: 'variable' };
        try {
          var r = await VideoEncoder.isConfigSupported(cfg);
          if (r.supported) return cfg;
        } catch (e) { /* next */ }
      }
    }
    return null;
  }

  async function pickAudioEncoder(rate, ch) {
    var cands = [
      { kind: 'aac', cfg: { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: ch, bitrate: 192000, aac: { format: 'aac' } } },
      { kind: 'opus', cfg: { codec: 'opus', sampleRate: 48000, numberOfChannels: ch, bitrate: 192000 } }
    ];
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].kind === 'opus' && rate !== 48000) continue;
      try {
        var r = await AudioEncoder.isConfigSupported(cands[i].cfg);
        if (r.supported) return cands[i];
      } catch (e) { /* next */ }
    }
    return null;
  }

  /** Decode [start, end] of the source's audio track to an AudioBuffer (sample-accurate). */
  async function decodeAudioRange(file, demux, start, end) {
    var a = demux && demux.audio;
    if (!a) return null;
    var cfg = await audioDecoderConfig(a);
    if (!cfg) throw Unsupported((a.codecName || 'audio') + ' decoding is not supported by WebCodecs here');
    var out = [], rate = 0, chs = 0, fail = null;
    var dec = new AudioDecoder({
      output: function (ad) {
        try {
          rate = ad.sampleRate; chs = ad.numberOfChannels;
          var planes = [];
          for (var c = 0; c < Math.min(2, chs); c++) {
            var arr = new Float32Array(ad.numberOfFrames);
            ad.copyTo(arr, { planeIndex: c, format: 'f32-planar' });
            planes.push(arr);
          }
          out.push({ ts: ad.timestamp / 1e6, planes: planes });
        } catch (e) { fail = fail || e; }
        ad.close();
      },
      error: function (e) { fail = fail || e; }
    });
    dec.configure(cfg);
    var reader = new CHDemux.SampleReader(file);
    var S = a.samples;
    for (var i = 0; i < S.length; i++) {
      var s = S[i];
      if (s.pts + s.dur < start - 0.1) continue;
      if (s.pts > end + 0.1) break;
      while (dec.decodeQueueSize > 32 && !fail) await sleep(0);
      if (fail) break;
      var data = await reader.read(s.offset, s.size);
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.pts * 1e6), duration: Math.round(s.dur * 1e6), data: data }));
    }
    try { await dec.flush(); } catch (e) { fail = fail || e; }
    try { dec.close(); } catch (e) { /* closed */ }
    if (fail) throw fail;
    if (!out.length || !rate) return null;
    var len = Math.max(1, Math.round((end - start) * rate));
    var nch = Math.max(1, Math.min(2, chs));
    var buf = new AudioBuffer({ length: len, numberOfChannels: nch, sampleRate: rate });
    out.forEach(function (chunk) {
      var off = Math.round((chunk.ts - start) * rate);
      for (var c = 0; c < nch; c++) {
        var src = chunk.planes[Math.min(c, chunk.planes.length - 1)];
        var i0 = Math.max(0, -off), i1 = Math.min(src.length, len - off);
        if (i1 > i0) buf.getChannelData(c).set(src.subarray(i0, i1), off + i0);
      }
    });
    return buf;
  }

  /**
   * @param {object} o
   *  file, demux, segs[{start,end,trans}], speed, rate{num,den,fps}, width, height, bitrate, canvas,
   *  compose(frame, tm, isLastOfSegment), onSegmentStart(i), onSegmentEnd(i), mixAudio() → AudioBuffer|null,
   *  onProgress({phase, frame, total, fps}), isCancelled()
   */
  async function render(o) {
    var vt = o.demux && o.demux.video;
    if (!vt) throw Unsupported('No decodable video track');
    var dcfg = await videoDecoderConfig(vt);
    if (!dcfg) throw Unsupported((vt.codecName || vt.codec || 'This') + ' video cannot be decoded with WebCodecs in this browser');
    var fps = o.rate.num / o.rate.den;
    var ecfg = await pickVideoEncoder(o.width, o.height, fps, o.bitrate);
    if (!ecfg) throw Unsupported('No H.264 encoder available for ' + o.width + '×' + o.height + ' @ ' + fps.toFixed(2) + ' fps');

    // ---- frame plan on an exact output grid ----
    var acc = 0;
    var plan = o.segs.map(function (s, i) {
      var d = (s.end - s.start) / o.speed;
      var p = { start: s.start, end: s.end, trans: s.trans, caption: s.caption || '', index: i, outStart: acc, outDur: d };
      acc += d;
      return p;
    });
    var total = acc;
    var N = Math.max(1, Math.round(total * fps));
    plan.forEach(function (p, i) {
      p.k0 = Math.round(p.outStart * fps);
      p.k1 = i === plan.length - 1 ? N : Math.round((p.outStart + p.outDur) * fps);
    });

    // ---- audio (offline, sample-accurate) ----
    o.onProgress({ phase: 'audio' });
    var audioBuf = await o.mixAudio();
    if (o.isCancelled()) throw Cancelled();
    var aenc = null;
    if (audioBuf) {
      aenc = await pickAudioEncoder(audioBuf.sampleRate, audioBuf.numberOfChannels);
      if (!aenc) throw Unsupported('No AAC or Opus audio encoder available');
    }

    var mux = new CHMp4Mux({
      width: o.width, height: o.height, fpsNum: o.rate.num, fpsDen: o.rate.den,
      audio: aenc ? { codec: aenc.kind, sampleRate: audioBuf.sampleRate, channels: audioBuf.numberOfChannels } : null
    });
    var fail = null;
    var venc = new VideoEncoder({ output: function (c, m) { mux.addVideo(c, m); }, error: function (e) { fail = fail || e; } });
    venc.configure(ecfg);
    var keyEvery = Math.max(1, Math.round(fps * 2));
    var frameUs = 1e6 * o.rate.den / o.rate.num;
    var emitted = 0, t0 = performance.now(), dupes = 0;
    var frameMap = new Float64Array(N); // source pts used for each output frame (diagnostics)

    function emit(frame, k, p) {
      var tm = { t: k / fps, T: total, u: (k - p.k0) / fps, segDur: p.outDur, segIndex: p.index, n: k, trans: p.trans, caption: p.caption, src: frame.timestamp / 1e6 };
      o.compose(frame, tm, k === p.k1 - 1);
      frameMap[k] = frame.timestamp / 1e6;
      var vf = new VideoFrame(o.canvas, { timestamp: Math.round(k * frameUs), duration: Math.round(frameUs) });
      venc.encode(vf, { keyFrame: k % keyEvery === 0 });
      vf.close();
      emitted++;
      if (emitted % 4 === 0 || emitted === N) {
        var el = (performance.now() - t0) / 1000;
        o.onProgress({ phase: 'video', frame: emitted, total: N, fps: emitted / Math.max(0.001, el), eta: (N - emitted) / Math.max(1, emitted / Math.max(0.001, el)) });
      }
    }

    var reader = new CHDemux.SampleReader(o.file);
    var samples = vt.samples;
    var srcFrameDur = vt.fpsInfo ? 1 / vt.fpsInfo.measured : 1 / 30;
    var sortedPts = samples.map(function (s) { return s.pts; }).sort(function (a, b) { return a - b; });
    // Frame displayed at time t = latest source frame with pts <= t
    function frameAt(t) {
      var lo = 0, hi = sortedPts.length - 1, ans = sortedPts[0];
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (sortedPts[mid] <= t + 1e-4) { ans = sortedPts[mid]; lo = mid + 1; } else hi = mid - 1; }
      return ans;
    }

    for (var pi = 0; pi < plan.length; pi++) {
      var p = plan[pi];
      if (o.isCancelled()) throw Cancelled();
      if (o.onSegmentStart) o.onSegmentStart(pi);
      if (p.k1 <= p.k0) { if (o.onSegmentEnd) o.onSegmentEnd(pi); continue; }
      await runSegment(p);
      if (o.onSegmentEnd) o.onSegmentEnd(pi);
    }

    async function runSegment(p) {
      var k = p.k0, prev = null, done = false;
      // Anchor the clip to the source frame showing at its In point and sample at frame
      // centres, so millisecond-rounded container timestamps can never flip a decision.
      var anchor = frameAt(p.start);
      var half = srcFrameDur * 0.5;
      var srcT = function (kk) { return anchor + ((kk - p.k0) / fps) * o.speed + half; };
      var eps = 0;
      var dec = new VideoDecoder({
        output: function (f) {
          if (done) { f.close(); return; }
          try {
            var pts = f.timestamp / 1e6;
            // Output frame k shows the latest source frame whose pts <= its source time.
            if (prev) {
              var used = 0;
              while (k < p.k1 && srcT(k) < pts - eps) { emit(prev, k, p); k++; used++; }
              if (used > 1) dupes += used - 1;
              prev.close();
            } else {
              while (k < p.k1 && srcT(k) < pts - eps) { emit(f, k, p); k++; }
            }
            prev = f;
            if (k >= p.k1) done = true;
          } catch (e) { fail = fail || e; try { f.close(); } catch (x) { /* closed */ } }
        },
        error: function (e) { fail = fail || e; }
      });
      dec.configure(dcfg);

      // last keyframe at or before the segment start (keyframes are in increasing pts order)
      var startIdx = 0;
      for (var j = 0; j < samples.length; j++) {
        var sj = samples[j];
        if (!sj.key) continue;
        if (sj.pts <= p.start + 1e-4) startIdx = j; else break;
      }
      for (j = startIdx; j < samples.length && !done; j++) {
        var s = samples[j];
        if (s.pts > p.end + 0.75) break;
        while ((dec.decodeQueueSize > 3 || venc.encodeQueueSize > 4) && !fail) await sleep(1);
        if (fail) break;
        if (o.isCancelled()) break;
        var data = await reader.read(s.offset, s.size);
        dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.pts * 1e6), duration: Math.max(1, Math.round(s.dur * 1e6)), data: data }));
      }
      if (!fail && !o.isCancelled()) { try { await dec.flush(); } catch (e) { fail = fail || e; } }
      if (fail) { try { dec.close(); } catch (x) { /* ignore */ } if (prev) prev.close(); throw fail; }
      if (o.isCancelled()) { try { dec.close(); } catch (x) { /* ignore */ } if (prev) prev.close(); throw Cancelled(); }
      if (prev) {
        while (k < p.k1) { emit(prev, k, p); k++; }
        prev.close(); prev = null;
      } else if (k < p.k1) {
        try { dec.close(); } catch (x) { /* ignore */ }
        throw new Error('No video frames could be decoded for clip ' + (p.index + 1));
      }
      done = true;
      try { dec.close(); } catch (x) { /* ignore */ }
    }

    // ---- encode audio ----
    if (audioBuf && aenc) {
      o.onProgress({ phase: 'encode-audio' });
      var ae = new AudioEncoder({ output: function (c, m) { mux.addAudio(c, m); }, error: function (e) { fail = fail || e; } });
      ae.configure(aenc.cfg);
      var n = audioBuf.length, ch = audioBuf.numberOfChannels, sr = audioBuf.sampleRate;
      var chans = [];
      for (var c = 0; c < ch; c++) chans.push(audioBuf.getChannelData(c));
      var step = Math.round(sr / 10);
      for (var off = 0; off < n; off += step) {
        var m = Math.min(step, n - off);
        var data = new Float32Array(m * ch);
        for (c = 0; c < ch; c++) data.set(chans[c].subarray(off, off + m), c * m);
        var ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: m, numberOfChannels: ch, timestamp: Math.round(off * 1e6 / sr), data: data });
        ae.encode(ad);
        ad.close();
        while (ae.encodeQueueSize > 16 && !fail) await sleep(1);
        if (fail) throw fail;
      }
      await ae.flush();
      ae.close();
    }

    o.onProgress({ phase: 'finalize' });
    await venc.flush();
    venc.close();
    if (fail) throw fail;
    var blob = mux.finalize();
    return {
      blob: blob, frames: mux.videoCount, expectedFrames: N, total: total, rate: o.rate,
      videoCodec: ecfg.codec, audioCodec: aenc ? aenc.kind : null, duplicatedForTiming: dupes, frameMap: frameMap,
      seconds: (performance.now() - t0) / 1000
    };
  }

  /**
   * Decode the whole video track once and hand a frame to onSample roughly every `step` seconds
   * (used by AI Edit analysis). Frames are delivered in presentation order.
   */
  async function scanVideo(file, demux, step, onSample, onProgress, isCancelled) {
    var vt = demux && demux.video;
    var cfg = await videoDecoderConfig(vt);
    if (!cfg) throw Unsupported('Video codec not decodable with WebCodecs');
    var next = 0, fail = null;
    var dec = new VideoDecoder({
      output: function (f) {
        var t = f.timestamp / 1e6;
        if (t + 1e-4 >= next) {
          try { onSample(f, t); } catch (e) { fail = fail || e; }
          next = (Math.floor(t / step + 1e-6) + 1) * step;
        }
        f.close();
      },
      error: function (e) { fail = fail || e; }
    });
    dec.configure(cfg);
    var reader = new CHDemux.SampleReader(file);
    var S = vt.samples, started = false;
    for (var i = 0; i < S.length; i++) {
      if (isCancelled()) break;
      var s = S[i];
      if (!started) { if (!s.key) continue; started = true; }
      while (dec.decodeQueueSize > 10 && !fail) {
        await Promise.race([new Promise(function (r) { dec.addEventListener('dequeue', r, { once: true }); }), sleep(8)]);
      }
      if (fail) break;
      var data = await reader.read(s.offset, s.size);
      dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.pts * 1e6), duration: Math.max(1, Math.round(s.dur * 1e6)), data: data }));
      if (i % 90 === 0) onProgress(i / S.length);
    }
    if (!fail && !isCancelled()) { try { await dec.flush(); } catch (e) { fail = fail || e; } }
    try { dec.close(); } catch (e) { /* closed */ }
    if (fail) throw fail;
  }

  return {
    supported: supported, render: render, decodeAudioRange: decodeAudioRange, scanVideo: scanVideo,
    videoDecoderConfig: videoDecoderConfig, audioDecoderConfig: audioDecoderConfig
  };
})();
