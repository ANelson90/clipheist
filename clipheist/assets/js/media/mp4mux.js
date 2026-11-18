/*
 * ClipHeist MP4 muxer: H.264 video + AAC or Opus audio → ISO BMFF (.mp4) with "fast start"
 * (moov before mdat). Video is written on an exact constant-frame-rate timeline
 * (e.g. 60000/1001 for 59.94 fps), so every frame has a precise timestamp.
 */
window.CHMp4Mux = (function () {
  'use strict';

  var te = new TextEncoder();
  function cat(arrs) {
    var n = 0, i;
    for (i = 0; i < arrs.length; i++) n += arrs[i].length;
    var o = new Uint8Array(n), p = 0;
    for (i = 0; i < arrs.length; i++) { o.set(arrs[i], p); p += arrs[i].length; }
    return o;
  }
  function u8(v) { return new Uint8Array([v & 255]); }
  function u16(v) { return new Uint8Array([(v >> 8) & 255, v & 255]); }
  function u24(v) { return new Uint8Array([(v >> 16) & 255, (v >> 8) & 255, v & 255]); }
  function u32(v) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
  function i32(v) { var b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v | 0); return b; }
  function u64(v) { var b = new Uint8Array(8); var dv = new DataView(b.buffer); dv.setUint32(0, Math.floor(v / 4294967296)); dv.setUint32(4, v >>> 0); return b; }
  function s4(s) { return te.encode(s); }
  function zeros(n) { return new Uint8Array(n); }
  function box(type) {
    var body = cat(Array.prototype.slice.call(arguments, 1));
    return cat([u32(body.length + 8), s4(type), body]);
  }
  function fbox(type, version, flags) {
    var rest = Array.prototype.slice.call(arguments, 3);
    return box.apply(null, [type, u8(version), u24(flags)].concat(rest));
  }
  var MATRIX = cat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  function toU8(x) {
    if (!x) return null;
    if (x instanceof Uint8Array) return x.slice();
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength));
    return new Uint8Array(x.slice(0));
  }
  function table(n, bytesPer, write) {
    var b = new Uint8Array(n * bytesPer), dv = new DataView(b.buffer);
    for (var i = 0; i < n; i++) write(dv, i * bytesPer, i);
    return b;
  }
  function runs(deltas) {
    var out = [];
    for (var i = 0; i < deltas.length; i++) {
      if (out.length && out[out.length - 1][1] === deltas[i]) out[out.length - 1][0]++;
      else out.push([1, deltas[i]]);
    }
    return out;
  }
  function sttsBox(deltas) {
    var r = runs(deltas);
    return fbox('stts', 0, 0, u32(r.length), table(r.length, 8, function (dv, o, i) { dv.setUint32(o, r[i][0]); dv.setUint32(o + 4, r[i][1]); }));
  }
  function stszBox(samples) {
    return fbox('stsz', 0, 0, u32(0), u32(samples.length), table(samples.length, 4, function (dv, o, i) { dv.setUint32(o, samples[i].data.length); }));
  }
  function co64Box(offsets) {
    return fbox('co64', 0, 0, u32(offsets.length), table(offsets.length, 8, function (dv, o, i) {
      dv.setUint32(o, Math.floor(offsets[i] / 4294967296)); dv.setUint32(o + 4, offsets[i] >>> 0);
    }));
  }
  var STSC_ONE = fbox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)); // one sample per chunk
  function dinf() { return box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1))); }
  function compressor(name) { var b = zeros(32); var t = te.encode(name).slice(0, 31); b[0] = t.length; b.set(t, 1); return b; }

  function Muxer(o) {
    this.o = o; // {width, height, fpsNum, fpsDen, audio: {codec:'aac'|'opus', sampleRate, channels} | null}
    this.v = []; this.a = [];
    this.avcC = null; this.aDesc = null;
    this.videoCount = 0;
  }
  Muxer.prototype.addVideo = function (chunk, meta) {
    if (!this.avcC && meta && meta.decoderConfig && meta.decoderConfig.description) this.avcC = toU8(meta.decoderConfig.description);
    var d = new Uint8Array(chunk.byteLength);
    chunk.copyTo(d);
    this.v.push({ data: d, key: chunk.type === 'key', ts: chunk.timestamp });
    this.videoCount++;
  };
  Muxer.prototype.addAudio = function (chunk, meta) {
    if (!this.aDesc && meta && meta.decoderConfig && meta.decoderConfig.description) this.aDesc = toU8(meta.decoderConfig.description);
    var d = new Uint8Array(chunk.byteLength);
    chunk.copyTo(d);
    this.a.push({ data: d, ts: chunk.timestamp, dur: chunk.duration });
  };

  Muxer.prototype.finalize = function () {
    var o = this.o, self = this;
    if (!this.v.length) throw new Error('No video frames were encoded');
    if (!this.avcC) throw new Error('Encoder did not provide an avcC configuration');
    var vScale = o.fpsDen === 1 ? o.fpsNum * 1000 : o.fpsNum;
    var vDelta = o.fpsDen === 1 ? 1000 : o.fpsDen;
    var frameUs = 1e6 * o.fpsDen / o.fpsNum;

    // video timing (handle B-frame reordering just in case: ctts from timestamps)
    var V = this.v;
    var needCtts = false;
    for (var i = 1; i < V.length; i++) if (V[i].ts < V[i - 1].ts) { needCtts = true; break; }
    var vDur = V.length * vDelta;

    // audio timing
    var A = this.a, hasA = !!(o.audio && A.length);
    var aRate = hasA ? o.audio.sampleRate : 0;
    var aDeltas = [];
    if (hasA) {
      var defDur = o.audio.codec === 'aac' ? 1024 : 960;
      for (i = 0; i < A.length; i++) {
        var dl = i + 1 < A.length ? Math.round((A[i + 1].ts - A[i].ts) * aRate / 1e6) : (A[i].dur ? Math.round(A[i].dur * aRate / 1e6) : defDur);
        aDeltas.push(Math.max(1, dl || defDur));
      }
    }
    var aDur = aDeltas.reduce(function (s, x) { return s + x; }, 0);

    // interleave samples by time
    var order = [];
    var vi = 0, ai = 0, aT = 0;
    while (vi < V.length || ai < A.length) {
      var vt = vi < V.length ? (vi * vDelta) / vScale : Infinity;
      var at = hasA && ai < A.length ? aT / aRate : Infinity;
      if (vt <= at) { order.push(['v', vi]); vi++; }
      else { order.push(['a', ai]); aT += aDeltas[ai]; ai++; }
      if (!hasA && vi >= V.length) break;
    }
    var dataLen = 0;
    order.forEach(function (x) { dataLen += (x[0] === 'v' ? V : A)[x[1]].data.length; });

    var durMs = Math.round(Math.max(vDur / vScale, hasA ? aDur / aRate : 0) * 1000);

    function videoTrak(offsets) {
      var w = o.width, h = o.height;
      var avc1 = box('avc1', zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(w), u16(h),
        u32(0x00480000), u32(0x00480000), u32(0), u16(1), compressor('ClipHeist H.264'), u16(0x18), u16(0xffff),
        box('avcC', self.avcC), box('pasp', u32(1), u32(1)));
      var stblParts = [fbox('stsd', 0, 0, u32(1), avc1), sttsBox(V.map(function () { return vDelta; }))];
      var keys = [];
      V.forEach(function (s, k) { if (s.key) keys.push(k + 1); });
      if (keys.length < V.length) stblParts.push(fbox('stss', 0, 0, u32(keys.length), table(keys.length, 4, function (dv, off, k) { dv.setUint32(off, keys[k]); })));
      if (needCtts) {
        stblParts.push(fbox('ctts', 1, 0, u32(V.length), table(V.length, 8, function (dv, off, k) {
          var ptsIdx = Math.round(V[k].ts / frameUs);
          dv.setUint32(off, 1); dv.setInt32(off + 4, (ptsIdx - k) * vDelta);
        })));
      }
      stblParts.push(STSC_ONE, stszBox(V), co64Box(offsets));
      return box('trak',
        fbox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMs), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(w * 65536), u32(h * 65536)),
        box('mdia',
          fbox('mdhd', 0, 0, u32(0), u32(0), u32(vScale), u32(vDur), u16(0x55c4), u16(0)),
          fbox('hdlr', 0, 0, u32(0), s4('vide'), zeros(12), te.encode('ClipHeist Video\0')),
          box('minf', fbox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)), dinf(), box.apply(null, ['stbl'].concat(stblParts)))));
    }

    function audioTrak(offsets) {
      var ch = o.audio.channels, entry;
      if (o.audio.codec === 'aac') {
        var asc = self.aDesc || new Uint8Array([0x11, 0x90]);
        var dsi = cat([u8(0x05), u8(asc.length), asc]);
        var dcd = cat([u8(0x04), u8(13 + dsi.length), u8(0x40), u8(0x15), u24(0), u32(192000), u32(192000), dsi]);
        var esd = cat([u8(0x03), u8(3 + dcd.length + 3), u16(1), u8(0), dcd, u8(0x06), u8(0x01), u8(0x02)]);
        entry = box('mp4a', zeros(6), u16(1), zeros(8), u16(ch), u16(16), u16(0), u16(0), u32(aRate * 65536), fbox('esds', 0, 0, esd));
      } else {
        var pre = 312;
        if (self.aDesc && self.aDesc.length >= 12) pre = self.aDesc[10] | (self.aDesc[11] << 8);
        entry = box('Opus', zeros(6), u16(1), zeros(8), u16(ch), u16(16), u16(0), u16(0), u32(48000 * 65536),
          box('dOps', u8(0), u8(ch), u16(pre), u32(48000), u16(0), u8(0)));
      }
      return box('trak',
        fbox('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(durMs), zeros(8), u16(0), u16(1), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
        box('mdia',
          fbox('mdhd', 0, 0, u32(0), u32(0), u32(aRate), u32(aDur), u16(0x55c4), u16(0)),
          fbox('hdlr', 0, 0, u32(0), s4('soun'), zeros(12), te.encode('ClipHeist Audio\0')),
          box('minf', fbox('smhd', 0, 0, u16(0), u16(0)), dinf(),
            box('stbl', fbox('stsd', 0, 0, u32(1), entry), sttsBox(aDeltas), STSC_ONE, stszBox(A), co64Box(offsets)))));
    }

    function moov(vOff, aOff) {
      var parts = ['moov',
        fbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(hasA ? 3 : 2)),
        videoTrak(vOff)];
      if (hasA) parts.push(audioTrak(aOff));
      return box.apply(null, parts);
    }

    var ftyp = box('ftyp', s4('isom'), u32(0x200), s4('isom'), s4('iso2'), s4('avc1'), s4('mp41'));
    var vOff = new Array(V.length).fill(0), aOff = new Array(A.length).fill(0);
    var moovLen = moov(vOff, aOff).length; // offsets are fixed-width, so length is stable
    var big = dataLen + 8 > 0xFFFFFFFF;
    var mdatHdr = big ? cat([u32(1), s4('mdat'), u64(dataLen + 16)]) : cat([u32(dataLen + 8), s4('mdat')]);
    var pos = ftyp.length + moovLen + mdatHdr.length;
    var parts = [];
    order.forEach(function (x) {
      var s = (x[0] === 'v' ? V : A)[x[1]];
      if (x[0] === 'v') vOff[x[1]] = pos; else aOff[x[1]] = pos;
      pos += s.data.length;
      parts.push(s.data);
    });
    var moovBox = moov(vOff, aOff);
    return new Blob([ftyp, moovBox, mdatHdr].concat(parts), { type: 'video/mp4' });
  };

  void i32;
  return Muxer;
})();
