/*
 * ClipHeist AI Edit: on-device footage analysis.
 *
 * Signals (10 Hz):  audio loudness, transient "impact" energy, frame-difference motion,
 *                   brightness flashes, color saturation, scene cuts, and the horizontal
 *                   centre of motion (used to follow the action when reframing to 9:16).
 * From these it scores every moment, picks the best non-overlapping highlights for a target
 * length and style, detects the beat of a music track for beat-synced cuts, and writes
 * titles/captions locally (an optional cloud writer can replace the copy).
 * Nothing leaves the device unless the cloud writer is enabled.
 */
window.CHAI = (function () {
  'use strict';

  var STEP = 0.1;

  function sorted(a) { return Float64Array.from(a).sort(); }
  function pct(a, p) { if (!a.length) return 0; var s = sorted(a); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; }
  function median(a) { return pct(a, 0.5); }
  function robust(a) {
    var m = median(a), hi = pct(a, 0.93), d = Math.max(1e-6, hi - m);
    var o = new Float32Array(a.length);
    for (var i = 0; i < a.length; i++) o[i] = Math.max(-1.5, Math.min(3, (a[i] - m) / d));
    return o;
  }
  function smooth(a, r) {
    var n = a.length, o = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var s = 0, w = 0;
      for (var k = -r; k <= r; k++) {
        var j = i + k;
        if (j < 0 || j >= n) continue;
        var wt = 1 - Math.abs(k) / (r + 1);
        s += a[j] * wt; w += wt;
      }
      o[i] = w ? s / w : 0;
    }
    return o;
  }
  function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /** Empty feature container for a clip of `duration` seconds. */
  function createFeatures(duration) {
    var n = Math.max(1, Math.ceil(duration / STEP));
    return {
      step: STEP, n: n, duration: duration,
      rms: new Float32Array(n), sharp: new Float32Array(n),
      motion: new Float32Array(n).fill(NaN), luma: new Float32Array(n).fill(NaN), sat: new Float32Array(n).fill(NaN),
      cx: new Float32Array(n).fill(NaN), cxw: new Float32Array(n),
      hasAudio: false, hasVideo: false
    };
  }

  /** Accumulate audio features from an AudioBuffer that starts at `t0` seconds. */
  function addAudio(F, buf, t0) {
    if (!buf) return;
    F.hasAudio = true;
    var sr = buf.sampleRate, ch = buf.numberOfChannels, len = buf.length;
    var a = buf.getChannelData(0), b = ch > 1 ? buf.getChannelData(1) : null;
    var hop = Math.round(sr * STEP);
    for (var s0 = 0; s0 < len; s0 += hop) {
      var idx = Math.round(t0 / STEP + s0 / hop);
      if (idx < 0 || idx >= F.n) continue;
      var e = 0, d = 0, prev = 0, s1 = Math.min(len, s0 + hop), c = 0;
      for (var i = s0; i < s1; i++) {
        var v = b ? (a[i] + b[i]) * 0.5 : a[i];
        e += v * v;
        var dv = v - prev; d += dv * dv; prev = v; c++;
      }
      if (!c) continue;
      F.rms[idx] = Math.sqrt(e / c);
      F.sharp[idx] = Math.sqrt(d / c);
    }
  }

  /** Per-frame visual features from a tiny RGBA thumbnail (e.g. 32×18). */
  function makeFrameSampler(w, h) {
    var prev = null;
    return function (F, t, rgba) {
      var idx = Math.round(t / STEP);
      if (idx < 0 || idx >= F.n) return;
      F.hasVideo = true;
      var n = w * h, lum = new Float32Array(n), satSum = 0, lumSum = 0;
      for (var i = 0, p = 0; i < n; i++, p += 4) {
        var r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
        var L = 0.299 * r + 0.587 * g + 0.114 * b;
        lum[i] = L; lumSum += L;
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        satSum += mx ? (mx - mn) / mx : 0;
      }
      F.luma[idx] = lumSum / n;
      F.sat[idx] = satSum / n;
      if (prev) {
        var diff = 0, colW = new Float32Array(w);
        for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
          var k = y * w + x, dd = Math.abs(lum[k] - prev[k]);
          diff += dd; colW[x] += dd;
        }
        F.motion[idx] = diff / n;
        var sw = 0, sx = 0;
        for (x = 0; x < w; x++) { sw += colW[x]; sx += colW[x] * x; }
        if (sw > 0) { F.cx[idx] = (sx / sw) / (w - 1); F.cxw[idx] = sw / n; }
      }
      prev = lum;
    };
  }

  function fillNaN(a, def) {
    var o = new Float32Array(a.length), last = NaN;
    for (var i = 0; i < a.length; i++) { if (!isNaN(a[i])) last = a[i]; o[i] = last; }
    last = NaN;
    for (i = a.length - 1; i >= 0; i--) { if (!isNaN(o[i])) last = o[i]; else o[i] = isNaN(last) ? def : last; }
    return o;
  }

  var STYLE_W = {
    hype: { loud: 0.28, onset: 0.3, motion: 0.3, flash: 0.12, sat: 0 },
    funny: { loud: 0.36, onset: 0.34, motion: 0.2, flash: 0.1, sat: 0 },
    cinematic: { loud: 0.08, onset: 0.04, motion: 0.22, flash: 0.08, sat: 0.38, calm: 0.2 },
    chill: { loud: -0.15, onset: -0.1, motion: 0.05, flash: 0, sat: 0.5, calm: 0.4 }
  };

  /** Score every 0.1 s of footage for a style. */
  function score(F, style) {
    var n = F.n, w = STYLE_W[style] || STYLE_W.hype;
    var db = new Float32Array(n), sdb = new Float32Array(n);
    for (var i = 0; i < n; i++) { db[i] = 20 * Math.log10(F.rms[i] + 1e-5); sdb[i] = 20 * Math.log10(F.sharp[i] + 1e-5); }
    var onsetRaw = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var win = [];
      for (var k = Math.max(0, i - 15); k < i; k++) win.push(sdb[k]);
      // need some history: codec priming / the silent first frames would otherwise look like an impact
      onsetRaw[i] = win.length >= 6 && db[i - 1] > -90 ? Math.max(0, sdb[i] - median(win)) : 0;
    }
    var motion = fillNaN(F.motion, 0), luma = fillNaN(F.luma, 0), sat = fillNaN(F.sat, 0);
    var flashRaw = new Float32Array(n), cuts = [];
    for (i = 5; i < n; i++) flashRaw[i] = Math.max(0, luma[i] - luma[i - 2]);
    if (F.hasVideo) {
      var mMed = median(motion), mHi = pct(motion, 0.97);
      for (i = 1; i < n - 1; i++) {
        var loc = [];
        for (k = Math.max(0, i - 10); k < Math.min(n, i + 10); k++) if (k !== i) loc.push(motion[k]);
        var lm = median(loc);
        if (motion[i] > Math.max(lm * 3.5, mMed * 2.5) && motion[i] >= mHi * 0.6 && motion[i] > motion[i - 1] && motion[i] >= motion[i + 1]) cuts.push(i * STEP);
      }
    }
    var L = F.hasAudio ? robust(db) : new Float32Array(n);
    var O = F.hasAudio ? robust(onsetRaw) : new Float32Array(n);
    var M = F.hasVideo ? robust(motion) : new Float32Array(n);
    var FL = F.hasVideo ? robust(flashRaw) : new Float32Array(n);
    var SA = F.hasVideo ? robust(sat) : new Float32Array(n);
    var wa = { loud: w.loud, onset: w.onset, motion: w.motion, flash: w.flash, sat: w.sat, calm: w.calm || 0 };
    if (!F.hasVideo) { wa.loud += wa.motion * 0.5 + wa.sat * 0.5; wa.onset += wa.motion * 0.5 + wa.flash; wa.motion = wa.flash = wa.sat = wa.calm = 0; }
    if (!F.hasAudio) { wa.motion += wa.loud + wa.onset * 0.5; wa.flash += wa.onset * 0.5; wa.loud = wa.onset = 0; }
    var raw = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var calm = -Math.abs(M[i] - 0.3); // steady, moderate motion
      raw[i] = wa.loud * L[i] + wa.onset * O[i] + wa.motion * M[i] + wa.flash * FL[i] + wa.sat * SA[i] + wa.calm * calm;
    }
    // reward build-up: rising loudness over the previous 3 s
    if (F.hasAudio && (style === 'hype' || style === 'funny')) {
      for (i = 30; i < n; i++) if (db[i - 30] > -90) raw[i] += 0.1 * Math.max(0, L[i] - L[i - 30]);
    }
    return { score: smooth(raw, 4), L: L, O: O, M: M, FL: FL, SA: SA, cuts: cuts };
  }

  var LEN = { hype: [2.5, 4.5, 7], funny: [3, 5.5, 9], cinematic: [4, 7, 11], chill: [5, 8, 12] };

  function reasonsAt(sc, i) {
    var r = [];
    if (sc.O[i] > 1.2) r.push('Impact spike');
    if (sc.L[i] > 1.1) r.push('Loud moment');
    if (sc.M[i] > 1.1) r.push('Fast action');
    if (sc.FL[i] > 1.4) r.push('Flash / explosion');
    if (sc.SA[i] > 1.1) r.push('Vivid scenery');
    if (!r.length) r.push(sc.M[i] > 0.3 ? 'Steady action' : 'Strong moment');
    return r;
  }

  /**
   * Pick highlights.
   * @param opts {style, target (output seconds or 0 = best only), speed, minGap}
   */
  function pick(F, sc, opts) {
    var n = F.n, s = sc.score, style = opts.style || 'hype', speed = opts.speed || 1;
    var lens = LEN[style] || LEN.hype, minLen = lens[0], baseLen = lens[1], maxLen = lens[2];
    var gap = opts.minGap != null ? opts.minGap : 1.0;
    var target = opts.target || 0;
    var base = median(s), top = pct(s, 0.995);
    var floor = target ? -Infinity : base + 0.45 * (top - base); // "best only" mode keeps strong moments only
    var order = Array.from({ length: n }, function (_, i) { return i; }).sort(function (a, b) { return s[b] - s[a]; });
    var taken = []; // [start, end]
    var picks = [], total = 0, dur = F.duration;
    for (var oi = 0; oi < order.length; oi++) {
      var idx = order[oi];
      if (target && total >= target - 0.3) break;
      if (!target && picks.length >= 12) break;
      if (s[idx] < floor) break;
      if (picks.length >= 2 && s[idx] < base + 0.18 * (top - base)) break; // don't pad the edit with filler
      var peakT = idx * STEP;
      if (taken.some(function (w) { return peakT > w[0] - gap && peakT < w[1] + gap; })) continue;
      // grow around the peak while the moment stays strong
      var thr = base + 0.5 * (s[idx] - base), a = idx, b = idx;
      while ((b - a) * STEP < maxLen) {
        var ca = a > 0 ? s[a - 1] : -Infinity, cb = b < n - 1 ? s[b + 1] : -Infinity;
        if (Math.max(ca, cb) < thr) break;
        if (ca >= cb) a--; else b++;
      }
      var len = Math.min(maxLen, Math.max(minLen, (b - a) * STEP + baseLen * 0.5));
      var start = peakT - 0.62 * len, end = start + len;
      if (a * STEP < start) { start = Math.max(a * STEP, peakT - maxLen * 0.8); end = Math.max(end, start + minLen); }
      if (b * STEP > end) end = Math.min(b * STEP, start + maxLen);
      // snap to scene cuts so clips don't begin or end one frame before a cut
      sc.cuts.forEach(function (c) {
        if (c > start && c < peakT - 0.8) start = c + 0.04;
        if (c > peakT + 0.6 && c < end) end = c - 0.04;
      });
      start = Math.max(0, start); end = Math.min(dur, end);
      if (end - start < minLen * 0.7) continue;
      if (taken.some(function (w) { return start < w[1] + gap && end > w[0] - gap; })) {
        // shrink to fit between neighbours
        taken.forEach(function (w) {
          if (w[1] <= peakT && w[1] + gap > start) start = Math.min(peakT, w[1] + gap);
          if (w[0] >= peakT && w[0] - gap < end) end = Math.max(peakT, w[0] - gap);
        });
        if (end - start < minLen * 0.7) continue;
      }
      if (target && total + (end - start) / speed > target + 0.5) {
        var room = (target - total) * speed;
        if (room < minLen * 0.7) continue;
        var cut = (end - start) - room;
        start += cut * 0.35; end -= cut * 0.65;
      }
      taken.push([start, end]);
      picks.push({ start: start, end: end, peak: peakT, score: s[idx], reasons: reasonsAt(sc, idx) });
      total += (end - start) / speed;
    }
    picks.sort(function (x, y) { return x.start - y.start; });
    if (opts.order === 'hook' && picks.length > 2) {
      var best = picks.reduce(function (m, p, i) { return p.score > picks[m].score ? i : m; }, 0);
      picks.unshift(picks.splice(best, 1)[0]);
    }
    return picks;
  }

  /** Follow-the-action horizontal track (0..1 across the source width), heavily smoothed. */
  function buildTrack(F) {
    var n = F.n, raw = new Float32Array(n).fill(NaN);
    var wMed = median(Array.from(F.cxw).filter(function (x) { return x > 0; })) || 0;
    for (var i = 0; i < n; i++) if (!isNaN(F.cx[i]) && F.cxw[i] > wMed * 0.6) raw[i] = F.cx[i];
    var x = fillNaN(raw, 0.5);
    x = smooth(smooth(x, 12), 12);
    var y = new Float32Array(n), maxStep = 0.022; // max pan speed ≈ 0.22 of width per second
    y[0] = x[0];
    for (i = 1; i < n; i++) y[i] = y[i - 1] + Math.max(-maxStep, Math.min(maxStep, x[i] - y[i - 1]));
    return { step: STEP, x: y };
  }
  function trackAt(track, t) {
    if (!track) return 0.5;
    var f = t / track.step, i = Math.floor(f);
    if (i <= 0) return track.x[0];
    if (i >= track.x.length - 1) return track.x[track.x.length - 1];
    var r = f - i;
    return track.x[i] * (1 - r) + track.x[i + 1] * r;
  }

  /** Tempo + beat grid for a music AudioBuffer (first 90 s analysed). */
  function detectBeats(buf) {
    if (!buf) return null;
    var sr = buf.sampleRate, len = Math.min(buf.length, Math.round(sr * 90));
    var a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    var hop = 512, win = 1024, nF = Math.floor((len - win) / hop);
    if (nF < 200) return null;
    var env = new Float32Array(nF), prevE = 0;
    for (var f = 0; f < nF; f++) {
      var e = 0, o = f * hop;
      for (var i = 0; i < win; i += 2) { var v = b ? (a[o + i] + b[o + i]) * 0.5 : a[o + i]; e += v * v; }
      var le = Math.log(1e-6 + e);
      env[f] = Math.max(0, le - prevE);
      prevE = le;
    }
    var fps = sr / hop, minLag = Math.floor(fps * 60 / 180), maxLag = Math.ceil(fps * 60 / 70);
    var best = -1, bestLag = minLag;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var acc = 0;
      for (f = lag; f < nF; f++) acc += env[f] * env[f - lag];
      var bpm = 60 * fps / lag;
      var wgt = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      acc *= wgt;
      if (acc > best) { best = acc; bestLag = lag; }
    }
    var period = bestLag / fps;
    var bestPh = 0, bestSum = -1;
    for (var ph = 0; ph < bestLag; ph++) {
      var sum = 0;
      for (f = ph; f < nF; f += bestLag) sum += env[f];
      if (sum > bestSum) { bestSum = sum; bestPh = ph; }
    }
    var first = bestPh / fps;
    return { bpm: 60 / period, period: period, first: first };
  }

  var TITLES = {
    hype: ['This went from 0 to 100 real quick 😳', 'Pure chaos in under a minute 🔥', 'I did NOT expect that ending', 'Peak gameplay, no notes 💯', 'The timing on this was unreal'],
    funny: ['Everything that could go wrong… did 💀', 'Physics said no 😂', 'Plan A failed. Plan B failed harder.', 'I swear I had a plan', 'My worst (best?) session yet 🤡'],
    cinematic: ['Golden hour hits different 🌅', 'Cinematic moments from tonight\'s session', 'This city is unreal at night', 'Shot entirely in-game 🎬', 'Some places just look better at dusk'],
    chill: ['Just cruising 🌴', 'Late-night drive, no plans', 'Scenic route only', 'No missions, just vibes', 'Taking the long way home']
  };
  var HOOKS = { hype: 'WAIT FOR IT…', funny: 'THIS DID NOT GO AS PLANNED', cinematic: '', chill: '' };
  var TAGS = {
    hype: ['gaming', 'gameplay', 'highlights', 'openworld', 'insane'],
    funny: ['gaming', 'funnymoments', 'fails', 'openworld', 'gamingclips'],
    cinematic: ['gaming', 'cinematic', 'gamephotography', 'openworld', 'virtualphotography'],
    chill: ['gaming', 'chill', 'scenic', 'openworld', 'cruising']
  };
  function localWriteup(style, vertical, picks, seed) {
    var h = hashStr(seed || 'clip');
    var list = TITLES[style] || TITLES.hype;
    var tags = (TAGS[style] || TAGS.hype).slice();
    if (vertical) tags.push('shorts', 'fyp');
    var counts = {};
    picks.forEach(function (p) { p.reasons.forEach(function (r) { counts[r] = (counts[r] || 0) + 1; }); });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || '';
    var desc = picks.length + ' moment' + (picks.length === 1 ? '' : 's') + ' from my session' + (top ? ', mostly ' + top.toLowerCase() : '') + '. Edited with ClipHeist.';
    return { title: list[h % list.length], description: desc, hashtags: tags, hook: HOOKS[style] || '', clipCaptions: [] };
  }

  /** Remove overlaps between picks (after beat quantization) without changing their order. */
  function resolveOverlaps(picks, duration, minLen) {
    var chrono = picks.slice().sort(function (x, y) { return x.start - y.start; });
    for (var i = 1; i < chrono.length; i++) {
      var prev = chrono[i - 1], cur = chrono[i];
      if (cur.start < prev.end) {
        var len = cur.end - cur.start;
        cur.start = prev.end;
        cur.end = Math.min(duration, cur.start + len);
      }
    }
    return picks.filter(function (p) { return p.end - p.start >= (minLen || 0.5); });
  }

  return {
    resolveOverlaps: resolveOverlaps,
    STEP: STEP, createFeatures: createFeatures, addAudio: addAudio, makeFrameSampler: makeFrameSampler,
    score: score, pick: pick, buildTrack: buildTrack, trackAt: trackAt, detectBeats: detectBeats, localWriteup: localWriteup
  };
})();
