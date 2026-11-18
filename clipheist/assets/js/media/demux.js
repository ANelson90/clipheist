/*
 * ClipHeist demuxer: MP4 / MOV (progressive + fragmented) and Matroska / WebM.
 * Builds per-track sample tables (file offsets + presentation timestamps) so WebCodecs
 * can decode EVERY frame of the source, independent of real-time playback.
 */
window.CHDemux = (function () {
  'use strict';

  // ---------- frame-rate analysis ----------
  var STD = [
    [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48000, 1001], [48, 1], [50, 1],
    [60000, 1001], [60, 1], [72, 1], [90, 1], [100, 1], [120000, 1001], [120, 1], [144, 1], [165, 1], [240, 1]
  ];
  function snapFps(fps) {
    if (!(fps > 0) || !isFinite(fps)) return null;
    var best = null, bestErr = 1;
    STD.forEach(function (r) {
      var v = r[0] / r[1];
      var e = Math.abs(v - fps) / v;
      if (e < bestErr) { bestErr = e; best = r; }
    });
    if (best && bestErr < 0.012) return { num: best[0], den: best[1], fps: best[0] / best[1] };
    var n = Math.max(1, Math.round(fps));
    return { num: n, den: 1, fps: n };
  }
  /** @param {number[]} pts sorted presentation times (seconds) */
  function analyzeFps(pts) {
    var d = [];
    for (var i = 1; i < pts.length; i++) { var x = pts[i] - pts[i - 1]; if (x > 1e-5) d.push(x); }
    if (d.length < 2) return null;
    var s = d.slice().sort(function (a, b) { return a - b; });
    var med = s[Math.floor(s.length / 2)];
    var mean = (pts[pts.length - 1] - pts[0]) / (pts.length - 1);
    var off = d.filter(function (x) { return Math.abs(x - med) / med > 0.25; }).length / d.length;
    var vfr = off > 0.05;
    var est = vfr ? 1 / med : 1 / mean;
    return { measured: est, vfr: vfr, rational: snapFps(est) };
  }

  // ---------- byte helpers ----------
  function fourcc(u, o) { return String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]); }
  function rd16(u, o) { return (u[o] << 8) | u[o + 1]; }
  function rd32(u, o) { return ((u[o] << 24) >>> 0) + (u[o + 1] << 16) + (u[o + 2] << 8) + u[o + 3]; }
  function rdI32(u, o) { return (u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]; }
  function rd64(u, o) { return rd32(u, o) * 4294967296 + rd32(u, o + 4); }
  function rdI64(u, o) { return rdI32(u, o) * 4294967296 + rd32(u, o + 4); }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function hex2(n) { return ('0' + n.toString(16)).slice(-2).toUpperCase(); }

  // ---------- codec strings ----------
  function avcCodec(b) { return 'avc1.' + hex2(b[1]) + hex2(b[2]) + hex2(b[3]); }
  function hevcCodec(b, prefix) {
    var space = b[1] >> 6, tier = (b[1] >> 5) & 1, prof = b[1] & 31;
    var compat = rd32(b, 2), rev = 0;
    for (var i = 0; i < 32; i++) rev = ((rev << 1) | ((compat >>> i) & 1)) >>> 0;
    var s = (prefix || 'hvc1') + '.' + ['', 'A', 'B', 'C'][space] + prof + '.' + rev.toString(16).toUpperCase() + '.' + (tier ? 'H' : 'L') + b[12];
    var cons = [b[6], b[7], b[8], b[9], b[10], b[11]];
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    cons.forEach(function (c) { s += '.' + c.toString(16).toUpperCase(); });
    return s;
  }
  function av1Codec(b) {
    var profile = b[1] >> 5, level = b[1] & 31, tier = b[2] >> 7;
    var hi = (b[2] >> 6) & 1, twelve = (b[2] >> 5) & 1;
    var depth = hi ? (twelve ? 12 : 10) : 8;
    return 'av01.' + profile + '.' + pad2(level) + (tier ? 'H' : 'M') + '.' + pad2(depth);
  }
  var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  function buildAsc(rate, ch) {
    var idx = AAC_RATES.indexOf(rate); if (idx < 0) idx = 3;
    return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | ((ch || 2) << 3)]);
  }
  function ascInfo(a) {
    var aot = a[0] >> 3;
    if (aot === 31) aot = 32 + (((a[0] & 7) << 3) | (a[1] >> 5));
    var idx = ((a[0] & 7) << 1) | (a[1] >> 7);
    return { aot: aot, rate: AAC_RATES[idx] || 0, ch: (a[1] >> 3) & 15 };
  }
  function opusHeadFromDops(d, chFallback) {
    // dOps is big-endian; OpusHead is little-endian
    var ch = d[1] || chFallback || 2, pre = rd16(d, 2), rate = rd32(d, 4), gain = rd16(d, 8), fam = d[10];
    var extra = fam ? d.subarray(11) : new Uint8Array(0);
    var h = new Uint8Array(19 + extra.length);
    h.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, ch, pre & 255, pre >> 8, rate & 255, (rate >> 8) & 255, (rate >> 16) & 255, (rate >>> 24) & 255, gain & 255, gain >> 8, fam]);
    h.set(extra, 19);
    return h;
  }
  function parseEsds(u, p, end) {
    var res = { oti: 0, asc: null };
    function len() { var n = 0, c, k = 0; do { c = u[p++]; n = (n << 7) | (c & 0x7f); k++; } while ((c & 0x80) && k < 4); return n; }
    while (p < end) {
      var tag = u[p++], l = len(), e = p + l;
      if (tag === 3) { p += 2; var f = u[p++]; if (f & 0x80) p += 2; if (f & 0x40) p += u[p] + 1; if (f & 0x20) p += 2; continue; }
      if (tag === 4) { res.oti = u[p]; p += 13; continue; }
      if (tag === 5) { res.asc = u.slice(p, e); p = e; continue; }
      p = e;
    }
    return res;
  }

  // ---------- ISO BMFF (MP4 / MOV) ----------
  function kids(u, start, end) {
    var out = [], p = start;
    while (p + 8 <= end) {
      var size = rd32(u, p), type = fourcc(u, p + 4), hs = 8;
      if (size === 1) { size = rd64(u, p + 8); hs = 16; } else if (size === 0) size = end - p;
      if (size < hs || p + size > end) break;
      out.push({ type: type, s: p, d: p + hs, e: p + size });
      p += size;
    }
    return out;
  }
  function kid(u, b, type) {
    var k = kids(u, b.d, b.e);
    for (var i = 0; i < k.length; i++) if (k[i].type === type) return k[i];
    return null;
  }
  function kidPath(u, b, arr) { for (var i = 0; i < arr.length && b; i++) b = kid(u, b, arr[i]); return b; }
  function findDeep(u, list, type) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].type === type) return list[i];
      if (list[i].type === 'wave') { var r = findDeep(u, kids(u, list[i].d, list[i].e), type); if (r) return r; }
    }
    return null;
  }

  function parseVisualEntry(u, e, tr) {
    tr.width = rd16(u, e.d + 24);
    tr.height = rd16(u, e.d + 26);
    var ks = kids(u, e.d + 78, e.e);
    var f = e.type;
    var find = function (t) { for (var i = 0; i < ks.length; i++) if (ks[i].type === t) return ks[i]; return null; };
    var c;
    if (f === 'avc1' || f === 'avc3') {
      c = find('avcC');
      if (c) { tr.description = u.slice(c.d, c.e); tr.codec = avcCodec(tr.description); }
      tr.codecName = 'H.264';
    } else if (f === 'hvc1' || f === 'hev1') {
      c = find('hvcC');
      if (c) { tr.description = u.slice(c.d, c.e); tr.codec = hevcCodec(tr.description, f); }
      tr.codecName = 'HEVC';
    } else if (f === 'vp09') {
      c = find('vpcC');
      if (c) { var b = u.subarray(c.d + 4, c.e); tr.codec = 'vp09.' + pad2(b[0]) + '.' + pad2(b[1]) + '.' + pad2(b[2] >> 4); }
      else tr.codec = 'vp09.00.10.08';
      tr.codecName = 'VP9';
    } else if (f === 'av01') {
      c = find('av1C');
      if (c) { tr.description = u.slice(c.d, c.e); tr.codec = av1Codec(tr.description); }
      tr.codecName = 'AV1';
    } else if (f === 'vp08') { tr.codec = 'vp8'; tr.codecName = 'VP8'; }
    else tr.codecName = f;
  }

  function parseAudioEntry(u, e, tr) {
    var ver = rd16(u, e.d + 8);
    tr.channels = rd16(u, e.d + 16);
    tr.sampleRate = rd32(u, e.d + 24) / 65536;
    var ks = e.d + 28;
    if (ver === 1) ks += 16;
    else if (ver === 2) {
      ks += 36;
      tr.sampleRate = new DataView(u.buffer, u.byteOffset + e.d + 32, 8).getFloat64(0);
      tr.channels = rd32(u, e.d + 40);
    }
    var kk = kids(u, ks, e.e);
    var f = e.type;
    if (f === 'mp4a') {
      var esds = findDeep(u, kk, 'esds');
      var r = esds ? parseEsds(u, esds.d + 4, esds.e) : { oti: 0x40, asc: null };
      if (r.oti === 0x6B || r.oti === 0x69) { tr.codec = 'mp3'; tr.codecName = 'MP3'; }
      else {
        if (r.asc && r.asc.length >= 2) {
          var inf = ascInfo(r.asc);
          tr.description = r.asc;
          tr.codec = 'mp4a.40.' + inf.aot;
          if (!tr.sampleRate) tr.sampleRate = inf.rate;
          if (!tr.channels) tr.channels = inf.ch;
        } else { tr.codec = 'mp4a.40.2'; tr.description = buildAsc(tr.sampleRate, tr.channels); }
        tr.codecName = 'AAC';
      }
    } else if (f === 'Opus') {
      var d = findDeep(u, kk, 'dOps');
      if (d) tr.description = opusHeadFromDops(u.subarray(d.d, d.e), tr.channels);
      tr.codec = 'opus'; tr.codecName = 'Opus'; tr.sampleRate = 48000;
    } else tr.codecName = f;
  }

  function parseTrak(u, t, mvTs) {
    var tkhd = kid(u, t, 'tkhd');
    var mdia = kid(u, t, 'mdia');
    if (!tkhd || !mdia) return null;
    var id = u[tkhd.d] === 1 ? rd32(u, tkhd.d + 20) : rd32(u, tkhd.d + 12);
    var mdhd = kid(u, mdia, 'mdhd');
    var ts = u[mdhd.d] === 1 ? rd32(u, mdhd.d + 20) : rd32(u, mdhd.d + 12);
    var hdlr = kid(u, mdia, 'hdlr');
    var h = hdlr ? fourcc(u, hdlr.d + 8) : '';
    var kind = h === 'vide' ? 'video' : h === 'soun' ? 'audio' : null;
    if (!kind) return null;
    var stbl = kidPath(u, mdia, ['minf', 'stbl']);
    if (!stbl) return null;
    var stsd = kid(u, stbl, 'stsd');
    var entry = stsd ? kids(u, stsd.d + 8, stsd.e)[0] : null;
    if (!entry) return null;
    var tr = { id: id, kind: kind, ts: ts, fourcc: entry.type, samples: [], shift: 0 };
    if (kind === 'video') parseVisualEntry(u, entry, tr); else parseAudioEntry(u, entry, tr);

    // edit list → presentation offset (matches what the <video> element shows)
    var elst = kidPath(u, t, ['edts', 'elst']);
    if (elst) {
      var v = u[elst.d], n = rd32(u, elst.d + 4), p = elst.d + 8, empty = 0, mediaStart = 0;
      for (var i = 0; i < n; i++) {
        var segDur, mt;
        if (v === 1) { segDur = rd64(u, p); mt = rdI64(u, p + 8); p += 20; }
        else { segDur = rd32(u, p); mt = rdI32(u, p + 4); p += 12; }
        if (mt === -1) empty += segDur; else { mediaStart = mt; break; }
      }
      tr.shift = empty / mvTs - mediaStart / ts;
    }

    // progressive sample tables
    var stsz = kid(u, stbl, 'stsz');
    var stco = kid(u, stbl, 'stco') || kid(u, stbl, 'co64');
    var count = stsz ? rd32(u, stsz.d + 8) : 0;
    if (count > 0 && stco) {
      var fixed = rd32(u, stsz.d + 4);
      var sizes = new Array(count);
      for (i = 0; i < count; i++) sizes[i] = fixed || rd32(u, stsz.d + 12 + 4 * i);
      var dts = new Float64Array(count), durs = new Float64Array(count);
      var stts = kid(u, stbl, 'stts');
      if (stts) {
        var en = rd32(u, stts.d + 4), q = stts.d + 8, k = 0, tt = 0;
        for (var a = 0; a < en; a++) {
          var c = rd32(u, q), dl = rd32(u, q + 4); q += 8;
          for (var j = 0; j < c && k < count; j++) { dts[k] = tt; durs[k] = dl; tt += dl; k++; }
        }
      }
      var cto = new Float64Array(count);
      var ctts = kid(u, stbl, 'ctts');
      if (ctts) {
        en = rd32(u, ctts.d + 4); q = ctts.d + 8; k = 0;
        for (a = 0; a < en; a++) {
          c = rd32(u, q); var off = rdI32(u, q + 4); q += 8;
          for (j = 0; j < c && k < count; j++) cto[k++] = off;
        }
      }
      var key = new Uint8Array(count);
      var stss = kid(u, stbl, 'stss');
      if (stss && kind === 'video') {
        en = rd32(u, stss.d + 4);
        for (a = 0; a < en; a++) { var sn = rd32(u, stss.d + 8 + 4 * a) - 1; if (sn >= 0 && sn < count) key[sn] = 1; }
      } else key.fill(1);
      var is64 = stco.type === 'co64';
      var nChunks = rd32(u, stco.d + 4);
      var chunkOff = function (ci) { return is64 ? rd64(u, stco.d + 8 + 8 * ci) : rd32(u, stco.d + 8 + 4 * ci); };
      var stsc = kid(u, stbl, 'stsc');
      var ents = [];
      if (stsc) {
        en = rd32(u, stsc.d + 4);
        for (a = 0; a < en; a++) ents.push({ first: rd32(u, stsc.d + 8 + 12 * a), spc: rd32(u, stsc.d + 12 + 12 * a) });
      }
      var offsets = new Float64Array(count), si = 0;
      for (var ei = 0; ei < ents.length && si < count; ei++) {
        var next = ei + 1 < ents.length ? ents[ei + 1].first : nChunks + 1;
        for (var ch = ents[ei].first; ch < next && si < count; ch++) {
          var o = chunkOff(ch - 1);
          for (j = 0; j < ents[ei].spc && si < count; j++) { offsets[si] = o; o += sizes[si]; si++; }
        }
      }
      for (i = 0; i < count; i++) {
        tr.samples.push({ pts: (dts[i] + cto[i]) / ts + tr.shift, dur: durs[i] / ts, offset: offsets[i], size: sizes[i], key: !!key[i] });
      }
    }
    return tr;
  }

  function parseMoof(mu, moofPos, byId, trex) {
    var moof = kids(mu, 0, mu.length)[0];
    if (!moof) return;
    kids(mu, moof.d, moof.e).forEach(function (tf) {
      if (tf.type !== 'traf') return;
      var tfhd = kid(mu, tf, 'tfhd');
      if (!tfhd) return;
      var fl = rd32(mu, tfhd.d) & 0xffffff, tid = rd32(mu, tfhd.d + 4), p = tfhd.d + 8;
      var tr = byId[tid];
      if (!tr) return;
      var dx = trex[tid] || { dur: 0, size: 0, flags: 0 };
      var base = moofPos, defDur = dx.dur, defSize = dx.size, defFlags = dx.flags;
      if (fl & 1) { base = rd64(mu, p); p += 8; }
      if (fl & 2) p += 4;
      if (fl & 8) { defDur = rd32(mu, p); p += 4; }
      if (fl & 0x10) { defSize = rd32(mu, p); p += 4; }
      if (fl & 0x20) { defFlags = rd32(mu, p); p += 4; }
      var tfdt = kid(mu, tf, 'tfdt');
      var t = tfdt ? (mu[tfdt.d] === 1 ? rd64(mu, tfdt.d + 4) : rd32(mu, tfdt.d + 4)) : (tr.nextDts || 0);
      var nextOff = null;
      kids(mu, tf.d, tf.e).forEach(function (tn) {
        if (tn.type !== 'trun') return;
        var v = mu[tn.d], f = rd32(mu, tn.d) & 0xffffff, n = rd32(mu, tn.d + 4), q = tn.d + 8;
        var off = nextOff != null ? nextOff : base;
        if (f & 1) { off = base + rdI32(mu, q); q += 4; }
        var first = null;
        if (f & 4) { first = rd32(mu, q); q += 4; }
        for (var i = 0; i < n; i++) {
          var dur = defDur, size = defSize, sf = defFlags, cto = 0;
          if (f & 0x100) { dur = rd32(mu, q); q += 4; }
          if (f & 0x200) { size = rd32(mu, q); q += 4; }
          if (f & 0x400) { sf = rd32(mu, q); q += 4; }
          if (i === 0 && first !== null) sf = first;
          if (f & 0x800) { cto = v === 1 ? rdI32(mu, q) : rd32(mu, q); q += 4; }
          tr.samples.push({ pts: (t + cto) / tr.ts + tr.shift, dur: dur / tr.ts, offset: off, size: size, key: tr.kind === 'audio' ? true : !(sf & 0x10000) });
          off += size; t += dur;
        }
        nextOff = off;
      });
      tr.nextDts = t;
    });
  }

  async function openMp4(file, onProgress) {
    var top = [], pos = 0, guard = 0;
    while (pos + 8 <= file.size && guard++ < 500000) {
      var h = new Uint8Array(await file.slice(pos, Math.min(file.size, pos + 16)).arrayBuffer());
      if (h.length < 8) break;
      var size = rd32(h, 0), type = fourcc(h, 4);
      if (size === 1) { if (h.length < 16) break; size = rd64(h, 8); } else if (size === 0) size = file.size - pos;
      if (size < 8) break;
      top.push({ type: type, pos: pos, size: size });
      pos += size;
    }
    var mv = top.find(function (b) { return b.type === 'moov'; });
    if (!mv) throw new Error('No movie header (moov) found');
    var u = new Uint8Array(await file.slice(mv.pos, mv.pos + mv.size).arrayBuffer());
    var moov = kids(u, 0, u.length)[0];
    var mvhd = kid(u, moov, 'mvhd');
    var mvTs = u[mvhd.d] === 1 ? rd32(u, mvhd.d + 20) : rd32(u, mvhd.d + 12);
    var trex = {};
    var mvex = kid(u, moov, 'mvex');
    if (mvex) kids(u, mvex.d, mvex.e).forEach(function (b) {
      if (b.type === 'trex') trex[rd32(u, b.d + 4)] = { dur: rd32(u, b.d + 12), size: rd32(u, b.d + 16), flags: rd32(u, b.d + 20) };
    });
    var tracks = kids(u, moov.d, moov.e).filter(function (b) { return b.type === 'trak'; })
      .map(function (t) { return parseTrak(u, t, mvTs); }).filter(Boolean);
    var byId = {};
    tracks.forEach(function (t) { byId[t.id] = t; });
    var moofs = top.filter(function (b) { return b.type === 'moof'; });
    for (var i = 0; i < moofs.length; i++) {
      var mu = new Uint8Array(await file.slice(moofs[i].pos, moofs[i].pos + moofs[i].size).arrayBuffer());
      parseMoof(mu, moofs[i].pos, byId, trex);
      if (onProgress && i % 50 === 0) onProgress(i / moofs.length);
    }
    return finish('mp4', tracks);
  }

  // ---------- Matroska / WebM ----------
  var TOP_IDS = { 0x1549A966: 1, 0x1654AE6B: 1, 0x1F43B675: 1, 0x1C53BB6B: 1, 0x1254C367: 1, 0x114D9B74: 1, 0x1043A770: 1, 0x1941A469: 1 };
  function vlen(b) { for (var i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 9; }
  function readId(u, p) { var l = vlen(u[p]); if (l > 4) return null; var v = 0; for (var i = 0; i < l; i++) v = v * 256 + u[p + i]; return { v: v, l: l }; }
  function readSz(u, p) {
    var l = vlen(u[p]); if (l > 8) return null;
    var v = u[p] & (0xff >> l), ones = v === (0xff >> l);
    for (var i = 1; i < l; i++) { v = v * 256 + u[p + i]; if (u[p + i] !== 0xff) ones = false; }
    return { v: ones ? -1 : v, l: l };
  }
  function uint(u, p, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + u[p + i]; return v; }
  function flt(u, p, n) { var dv = new DataView(u.buffer, u.byteOffset + p, n); return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); }
  function str(u, p, n) { var s = ''; for (var i = 0; i < n && u[p + i]; i++) s += String.fromCharCode(u[p + i]); return s; }
  function mkids(u, s, e) {
    var out = [], p = s;
    while (p < e) {
      var id = readId(u, p); if (!id) break;
      var sz = readSz(u, p + id.l); if (!sz) break;
      var d = p + id.l + sz.l;
      var size = sz.v < 0 ? e - d : Math.min(sz.v, e - d);
      out.push({ id: id.v, d: d, size: size });
      p = d + size;
    }
    return out;
  }

  function Reader(file) { this.file = file; this.base = 0; this.buf = null; }
  Reader.prototype.ensure = async function (pos, n) {
    if (pos + n > this.file.size) n = this.file.size - pos;
    if (n <= 0) return false;
    if (this.buf && pos >= this.base && pos + n <= this.base + this.buf.length) return true;
    var end = Math.min(this.file.size, pos + Math.max(n, 8 << 20));
    this.buf = new Uint8Array(await this.file.slice(pos, end).arrayBuffer());
    this.base = pos;
    return true;
  };
  Reader.prototype.el = async function (pos) {
    if (!(await this.ensure(pos, 12))) return null;
    var u = this.buf, o = pos - this.base;
    var id = readId(u, o); if (!id) return null;
    var sz = readSz(u, o + id.l); if (!sz) return null;
    return { id: id.v, size: sz.v, data: pos + id.l + sz.l };
  };
  Reader.prototype.bytes = async function (pos, n) {
    await this.ensure(pos, n);
    var o = pos - this.base;
    return this.buf.slice(o, o + n);
  };

  function mkvBlock(h, fileOff, size, ctc, simple, hasRef, tracks, tcScale) {
    var tn = readSz(h, 0);
    if (!tn) return;
    var q = tn.l;
    var tr = tracks[tn.v];
    if (!tr || !tr.kind) return;
    var tc = (h[q] << 8) | h[q + 1]; if (tc & 0x8000) tc -= 0x10000;
    var fl = h[q + 2]; q += 3;
    var key = simple ? !!(fl & 0x80) : !hasRef;
    var pts = (ctc + tc) * tcScale / 1e9;
    var lacing = (fl >> 1) & 3;
    if (!lacing) { tr.samples.push({ pts: pts, dur: 0, offset: fileOff + q, size: size - q, key: key || tr.kind === 'audio' }); return; }
    var n = h[q] + 1; q++;
    var sizes = [], i;
    if (lacing === 1) {
      for (i = 0; i < n - 1; i++) { var s = 0, b; do { b = h[q++]; s += b; } while (b === 255); sizes.push(s); }
    } else if (lacing === 3) {
      var f = readSz(h, q); q += f.l; sizes.push(f.v);
      for (i = 1; i < n - 1; i++) { var dd = readSz(h, q); var bias = Math.pow(2, 7 * dd.l - 1) - 1; q += dd.l; sizes.push(sizes[i - 1] + (dd.v - bias)); }
    } else {
      var each = Math.floor((size - q) / n);
      for (i = 0; i < n - 1; i++) sizes.push(each);
    }
    var used = sizes.reduce(function (a, c) { return a + c; }, 0);
    sizes.push(size - q - used);
    var off = fileOff + q;
    var fd = tr.defaultDur ? tr.defaultDur / 1e9 : 0;
    sizes.forEach(function (sz, k) {
      tr.samples.push({ pts: pts + k * fd, dur: 0, offset: off, size: sz, key: key || tr.kind === 'audio' });
      off += sz;
    });
  }

  function mkvCodec(tr) {
    var id = tr.codecId || '', p = tr.priv;
    if (id === 'V_MPEG4/ISO/AVC' && p) { tr.codec = avcCodec(p); tr.description = p; tr.codecName = 'H.264'; }
    else if (id === 'V_MPEGH/ISO/HEVC' && p) { tr.codec = hevcCodec(p, 'hvc1'); tr.description = p; tr.codecName = 'HEVC'; }
    else if (id === 'V_VP9') { tr.codec = 'vp09.00.10.08'; tr.altCodecs = ['vp09.00.40.08', 'vp09.02.10.10', 'vp09.01.10.08']; tr.codecName = 'VP9'; }
    else if (id === 'V_VP8') { tr.codec = 'vp8'; tr.codecName = 'VP8'; }
    else if (id === 'V_AV1') { if (p && p.length >= 4) { tr.codec = av1Codec(p); tr.description = p; } else tr.codec = 'av01.0.08M.08'; tr.codecName = 'AV1'; }
    else if (id === 'A_OPUS') { tr.codec = 'opus'; tr.description = p; tr.codecName = 'Opus'; tr.sampleRate = 48000; }
    else if (id.indexOf('A_AAC') === 0) { tr.codec = 'mp4a.40.2'; tr.description = p || buildAsc(tr.sampleRate, tr.channels); tr.codecName = 'AAC'; }
    else if (id === 'A_VORBIS') { tr.codec = 'vorbis'; tr.description = p; tr.codecName = 'Vorbis'; }
    else if (id === 'A_MPEG/L3') { tr.codec = 'mp3'; tr.codecName = 'MP3'; }
    else if (id === 'A_FLAC') { tr.codec = 'flac'; tr.description = p; tr.codecName = 'FLAC'; }
    else tr.codecName = id.replace(/^[AV]_/, '');
  }

  async function openMkv(file, onProgress) {
    var r = new Reader(file);
    var hdr = await r.el(0);
    if (!hdr || hdr.id !== 0x1A45DFA3) throw new Error('Not a Matroska/WebM file');
    var seg = await r.el(hdr.data + hdr.size);
    if (!seg || seg.id !== 0x18538067) throw new Error('No Matroska segment');
    var segEnd = seg.size < 0 ? file.size : Math.min(file.size, seg.data + seg.size);
    var p = seg.data, tcScale = 1e6, tracks = {}, lastReport = 0;
    while (p < segEnd) {
      var e = await r.el(p);
      if (!e) break;
      if (e.id === 0x1549A966 && e.size > 0) {
        var ib = await r.bytes(e.data, e.size);
        mkids(ib, 0, ib.length).forEach(function (k) { if (k.id === 0x2AD7B1) tcScale = uint(ib, k.d, k.size); });
      } else if (e.id === 0x1654AE6B && e.size > 0) {
        var tb = await r.bytes(e.data, e.size);
        mkids(tb, 0, tb.length).forEach(function (te) {
          if (te.id !== 0xAE) return;
          var t = { samples: [] };
          mkids(tb, te.d, te.d + te.size).forEach(function (k) {
            if (k.id === 0xD7) t.num = uint(tb, k.d, k.size);
            else if (k.id === 0x83) t.type = uint(tb, k.d, k.size);
            else if (k.id === 0x86) t.codecId = str(tb, k.d, k.size);
            else if (k.id === 0x63A2) t.priv = tb.slice(k.d, k.d + k.size);
            else if (k.id === 0x23E383) t.defaultDur = uint(tb, k.d, k.size);
            else if (k.id === 0xE0) mkids(tb, k.d, k.d + k.size).forEach(function (v) {
              if (v.id === 0xB0) t.width = uint(tb, v.d, v.size);
              else if (v.id === 0xBA) t.height = uint(tb, v.d, v.size);
            });
            else if (k.id === 0xE1) mkids(tb, k.d, k.d + k.size).forEach(function (a) {
              if (a.id === 0xB5) t.sampleRate = flt(tb, a.d, a.size);
              else if (a.id === 0x9F) t.channels = uint(tb, a.d, a.size);
            });
          });
          t.kind = t.type === 1 ? 'video' : t.type === 2 ? 'audio' : null;
          if (t.kind === 'audio') { t.sampleRate = t.sampleRate || 48000; t.channels = t.channels || 2; }
          mkvCodec(t);
          tracks[t.num] = t;
        });
      } else if (e.id === 0x1F43B675) {
        var end = e.size < 0 ? segEnd : Math.min(segEnd, e.data + e.size);
        var cp = e.data, ctc = 0;
        while (cp < end) {
          var c = await r.el(cp);
          if (!c) { cp = end; break; }
          if (e.size < 0 && TOP_IDS[c.id]) break;
          if (c.id === 0xE7) { var tcb = await r.bytes(c.data, c.size); ctc = uint(tcb, 0, c.size); }
          else if (c.id === 0xA3 && c.size > 0) {
            var bh = await r.bytes(c.data, Math.min(c.size, 4096));
            mkvBlock(bh, c.data, c.size, ctc, true, false, tracks, tcScale);
          } else if (c.id === 0xA0 && c.size > 0) {
            // BlockGroup: find Block (0xA1) + ReferenceBlock (0xFB)
            var gk = mkids(await r.bytes(c.data, c.size), 0, c.size);
            var blk = null, ref = false;
            gk.forEach(function (k) { if (k.id === 0xA1) blk = k; else if (k.id === 0xFB) ref = true; });
            if (blk) {
              var bh2 = await r.bytes(c.data + blk.d, Math.min(blk.size, 4096));
              mkvBlock(bh2, c.data + blk.d, blk.size, ctc, false, ref, tracks, tcScale);
            }
          }
          if (c.size < 0) { cp = end; break; }
          cp = c.data + c.size;
        }
        p = cp;
        if (onProgress && p - lastReport > 32 << 20) { lastReport = p; onProgress(p / file.size); }
        continue;
      }
      if (e.size < 0) break;
      p = e.data + e.size;
    }
    var list = Object.keys(tracks).map(function (k) { return tracks[k]; });
    return finish('mkv', list);
  }

  // ---------- finalize ----------
  function finish(container, tracks) {
    var video = null, audio = null;
    tracks.forEach(function (t) {
      if (!t.samples || !t.samples.length) return;
      var pts = t.samples.map(function (s) { return s.pts; }).sort(function (a, b) { return a - b; });
      t.firstPts = pts[0];
      if (t.kind === 'video') {
        t.fpsInfo = analyzeFps(pts);
        var fd = t.fpsInfo ? 1 / t.fpsInfo.measured : 1 / 30;
        t.samples.forEach(function (s) { if (!(s.dur > 0)) s.dur = fd; });
        t.duration = pts[pts.length - 1] + fd;
        if (!video) video = t;
      } else if (t.kind === 'audio') {
        for (var i = 0; i < t.samples.length; i++) {
          var s = t.samples[i];
          if (!(s.dur > 0)) s.dur = i + 1 < t.samples.length ? Math.max(0, t.samples[i + 1].pts - s.pts) : 0.02;
        }
        var last = t.samples[t.samples.length - 1];
        t.duration = last.pts + last.dur;
        if (!audio) audio = t;
      }
    });
    return { container: container, video: video, audio: audio, duration: Math.max(video ? video.duration : 0, audio ? audio.duration : 0) };
  }

  async function open(file, onProgress) {
    var head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) return openMkv(file, onProgress);
    var t = fourcc(head, 4);
    if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot', 'uuid'].indexOf(t) >= 0) return openMp4(file, onProgress);
    throw new Error('Unrecognized container');
  }

  /** Windowed reader for sample payloads. */
  function SampleReader(file) { this.file = file; this.base = -1; this.buf = null; }
  SampleReader.prototype.read = async function (off, size) {
    if (!this.buf || off < this.base || off + size > this.base + this.buf.length) {
      var end = Math.min(this.file.size, off + Math.max(size, 6 << 20));
      this.buf = new Uint8Array(await this.file.slice(off, end).arrayBuffer());
      this.base = off;
    }
    return this.buf.subarray(off - this.base, off - this.base + size);
  };

  return { open: open, SampleReader: SampleReader, analyzeFps: analyzeFps, snapFps: snapFps };
})();
