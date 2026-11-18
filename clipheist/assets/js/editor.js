/*
 * ClipHeist Studio — in-browser gameplay clip editor.
 *
 * Preview:  <video> decode → requestVideoFrameCallback → canvas compositor, so the preview draws
 *           exactly once per decoded source frame at the source's own cadence.
 * Export:   1) Frame-exact engine (WebCodecs, media/exact.js): decodes every frame from the file,
 *              composes it at an exact output frame grid, encodes H.264 + AAC/Opus, writes a
 *              constant-frame-rate MP4. Audio is mixed offline, sample-accurately.
 *           2) Real-time engine (MediaRecorder): compatibility fallback for browsers without WebCodecs.
 */
(function () {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CFG = window.CLIPHEIST_CONFIG || {};
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const STORE_KEY = 'clipheist.settings.v2';
  const HAS_RVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const CLIP_COLORS = ['#22d8e0', '#ff3d81', '#ffb22b', '#3ddc97', '#8b5cf6', '#ff6a4d'];
  const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);

  function fmt(t, cs) {
    if (!isFinite(t) || t < 0) t = 0;
    let m = Math.floor(t / 60);
    const s = t - m * 60;
    if (cs === false) return m + ':' + String(Math.floor(s)).padStart(2, '0');
    let str = s.toFixed(2);
    if (str === '60.00') { m += 1; str = '0.00'; }
    return m + ':' + str.padStart(5, '0');
  }
  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function once(el, ev, ms) {
    return new Promise((resolve, reject) => {
      let timer;
      const h = () => { clearTimeout(timer); resolve(); };
      el.addEventListener(ev, h, { once: true });
      if (ms) timer = setTimeout(() => { el.removeEventListener(ev, h); reject(new Error('timeout:' + ev)); }, ms);
    });
  }
  function slug(s) {
    return (s || 'clip').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 60) || 'clip';
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 5000 : 2600);
  }

  // ---------- catalogues ----------
  const PRESETS = {
    'yt-1080': { name: 'YouTube', size: '1920×1080 · 16:9', w: 1920, h: 1080 },
    'shorts': { name: 'Shorts · TikTok · Reels', size: '1080×1920 · 9:16', w: 1080, h: 1920 },
    'yt-1440': { name: 'YouTube 1440p', size: '2560×1440 · 16:9', w: 2560, h: 1440 },
    'yt-4k': { name: 'YouTube 4K', size: '3840×2160 · 16:9', w: 3840, h: 2160 },
    'feed45': { name: 'Instagram feed', size: '1080×1350 · 4:5', w: 1080, h: 1350 },
    'square': { name: 'Square', size: '1080×1080 · 1:1', w: 1080, h: 1080 },
    'x-720': { name: 'X · Discord', size: '1280×720 · 16:9', w: 1280, h: 720 },
    'shorts-720': { name: 'Vertical light', size: '720×1280 · 9:16', w: 720, h: 1280 }
  };
  const LOOKS = {
    original: { label: 'Original', dot: '#888', v: { brightness: 100, contrast: 100, saturation: 100, tintAmt: 0, vignette: 0 } },
    vivid: { label: 'Vivid', dot: '#3ddc97', v: { brightness: 102, contrast: 112, saturation: 150, tintAmt: 0, vignette: 12 } },
    golden: { label: 'Golden Hour', dot: '#ffb22b', v: { brightness: 104, contrast: 108, saturation: 125, tint: '#ff9a3c', tintAmt: 24, vignette: 25 } },
    neon: { label: 'Neon Night', dot: '#ff3d81', v: { brightness: 100, contrast: 120, saturation: 140, tint: '#ff2e88', tintAmt: 20, vignette: 38 } },
    ocean: { label: 'Ocean Drive', dot: '#22d8e0', v: { brightness: 101, contrast: 110, saturation: 118, tint: '#22d8e0', tintAmt: 16, vignette: 20 } },
    bleach: { label: 'Bleach', dot: '#d9e6ff', v: { brightness: 106, contrast: 128, saturation: 55, tint: '#d9e6ff', tintAmt: 10, vignette: 18 } },
    noir: { label: 'Noir', dot: '#fff', v: { brightness: 100, contrast: 138, saturation: 0, tintAmt: 0, vignette: 48 } }
  };
  const LOOK_KEYS = ['brightness', 'contrast', 'saturation', 'tint', 'tintAmt', 'vignette'];
  const TRANSITIONS = [
    { id: 'cut', label: 'Cut', icon: '│' },
    { id: 'fade', label: 'Crossfade', icon: '◐' },
    { id: 'black', label: 'Dip black', icon: '■' },
    { id: 'white', label: 'Flash', icon: '✦' },
    { id: 'slide', label: 'Slide', icon: '⇠' },
    { id: 'push', label: 'Push up', icon: '⇡' },
    { id: 'wipe', label: 'Wipe', icon: '▚' },
    { id: 'zoom', label: 'Zoom punch', icon: '⊕' },
    { id: 'whip', label: 'Whip pan', icon: '≋' },
    { id: 'glitch', label: 'Glitch', icon: '▦' },
    { id: 'iris', label: 'Iris', icon: '◎' }
  ];
  const TRANS_LABEL = Object.fromEntries(TRANSITIONS.map((t) => [t.id, t.label]));
  const EFFECTS = [
    { id: 'Shake', label: 'Camera shake', amt: true, tip: 'Handheld energy, deterministic per frame' },
    { id: 'Impact', label: 'Impact zoom', amt: true, tip: 'Punch-in at the start of every clip' },
    { id: 'Push', label: 'Slow push-in', amt: true, tip: 'Gradual zoom across each clip' },
    { id: 'Glow', label: 'Glow / bloom', amt: true, tip: 'Soft light bloom on highlights' },
    { id: 'Rgb', label: 'RGB split', amt: true, tip: 'Chromatic aberration' },
    { id: 'Grain', label: 'Film grain', amt: true, tip: 'Animated grain, changes every frame' },
    { id: 'Vhs', label: 'VHS', amt: true, tip: 'Scanlines, chroma bleed, tracking band' },
    { id: 'Mirror', label: 'Mirror (flip)', amt: false, tip: 'Flip the image horizontally' },
    { id: 'BwEnd', label: 'Black & white ending', amt: 'dur', tip: 'Drains color over the final seconds' }
  ];
  const FX_KEYS = EFFECTS.flatMap((e) => ['fx' + e.id, 'fx' + e.id + 'Amt']).concat(['fxBwEndDur']);
  const FX_PRESETS = {
    none: { label: 'None', on: {} },
    action: { label: 'Action', on: { Impact: 60, Shake: 30, Glow: 30 } },
    cinematic: { label: 'Cinematic', on: { Push: 45, Grain: 22 }, extra: { bars: true } },
    retro: { label: 'Retro VHS', on: { Vhs: 60, Rgb: 25, Grain: 40 } },
    dreamy: { label: 'Dreamy', on: { Glow: 65, Push: 30 } },
    chaos: { label: 'Chaos', on: { Shake: 70, Rgb: 55, Impact: 85 } }
  };
  const PLATFORMS = [
    { id: 'youtube', name: 'YouTube', color: '#ff3d3d', url: 'https://www.youtube.com/upload' },
    { id: 'shorts', name: 'Shorts', color: '#ff3d81', url: 'https://www.youtube.com/upload' },
    { id: 'tiktok', name: 'TikTok', color: '#22d8e0', url: 'https://www.tiktok.com/upload' },
    { id: 'instagram', name: 'Instagram', color: '#c13584', url: 'https://www.instagram.com/' },
    { id: 'x', name: 'X', color: '#e7e7e7', url: 'https://x.com/compose/post' },
    { id: 'facebook', name: 'Facebook', color: '#1877f2', url: 'https://www.facebook.com/reels/create' },
    { id: 'reddit', name: 'Reddit', color: '#ff4500', url: 'https://www.reddit.com/submit' },
    { id: 'discord', name: 'Discord', color: '#5865f2', url: 'https://discord.com/app' }
  ];
  const FPS_CHOICES = [['23.976', 24000, 1001], ['24', 24, 1], ['25', 25, 1], ['29.97', 30000, 1001], ['30', 30, 1], ['50', 50, 1], ['59.94', 60000, 1001], ['60', 60, 1]];

  const DEFAULTS = {
    preset: 'yt-1080', frame: 'fill', zoom: 100, panX: 50, panY: 50,
    look: 'original', brightness: 100, contrast: 100, saturation: 100, tint: '#ff9a3c', tintAmt: 0, vignette: 0, bars: false,
    fadeIn: 0.3, fadeOut: 0.6,
    transition: 'fade', transDur: 0.5, transSfx: false,
    caption: '', captionPos: 'bottom', captionSize: 6, captionColor: '#ffffff', captionStyle: 'outline', captionTiming: 'always', captionUpper: true, captionAnim: 'pop',
    handle: '', handleCorner: 'br',
    gameVol: 100, muteGame: false, musicVol: 60, musicStart: 0,
    outFps: 'match', bitrate: 16, container: 'auto', engine: 'auto', speed: 1, loop: true, safe: false,
    title: '', description: '', tags: CFG.defaultHashtags || '#gaming #clips'
  };
  EFFECTS.forEach((e) => { DEFAULTS['fx' + e.id] = false; if (e.amt === true) DEFAULTS['fx' + e.id + 'Amt'] = 50; });
  DEFAULTS.fxBwEndDur = 1.5;
  Object.assign(DEFAULTS, {
    autoReframe: false,
    voPolish: true, voFilter: 'none', voDuck: 10, voOffset: -40, voSubs: true, voAuto: true, voMonitor: true, voNoise: true, voFrom: 'start',
    aiTarget: 'short30', aiStyle: 'hype', aiOrder: 'hook', aiReframe: true, aiFx: true, aiBeat: true, aiCaptions: true, aiCloud: true, aiNotes: ''
  });

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  let saveTimer;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* unavailable */ } }, 300);
  }

  const S = Object.assign({}, DEFAULTS, loadSettings());
  if (!PRESETS[S.preset]) S.preset = DEFAULTS.preset;

  const R = {
    file: null, url: null, duration: 0, ready: false, loadToken: 0,
    inPt: 0, outPt: 0, clips: [], nextClipId: 1,
    exporting: false, cancel: false, exp: null, seq: null, snapReady: false,
    musicUrl: null, musicFile: null, musicBuf: null,
    result: null, downloaded: false, thumbsToken: 0,
    mediaTime: 0, dirty: true,
    src: { fps: null, vfr: false, width: 0, height: 0, vcodec: '', acodec: '' },
    demux: null, demuxPromise: null, demuxState: 'idle', exactOk: false, exactReason: '',
    fullAudio: null, vfcCount: 0, fpsWindow: { t: 0, n: 0, dropped: 0, fps: 0 }
  };

  Object.assign(R, { vo: [], voNodes: [], voRec: null, nextVoId: 1, ai: null, aiUndo: null, aiBusy: false, aiCancel: false });

  // ---------- canvases ----------
  // Two decoders: `video` is the one on screen, `standby` is pre-seeked to the next reel clip so
  // clip boundaries swap instantly instead of waiting for a seek + keyframe decode.
  const vA = $('#video'), vB = $('#video2');
  let video = vA, standby = vB;
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const HAS_FILTER = typeof ctx.filter === 'string';
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w || 1; c.height = h || 1; return c; };
  const bg = mk(48, 27); const bctx = bg.getContext('2d');
  let cleanC = mk(), snapC = mk();
  const tmpC = mk(), chanC = mk(), glowA = mk(), glowB = mk();
  const tctx = tmpC.getContext('2d'), chctx = chanC.getContext('2d'), gaCtx = glowA.getContext('2d'), gbCtx = glowB.getContext('2d');
  let grainTiles = null, scanTile = null;
  const timeline = $('#timeline');

  R.quality = 1; // adaptive preview-resolution factor (drops under load, recovers when there's headroom)
  /** Preview resolution: what's actually visible on screen (× devicePixelRatio), never more than the export size. */
  function previewScale(p) {
    const el = R.aipOn ? $('#aipCanvas') : $('#viewport');
    const r = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let disp;
    if (R.aipOn && r.height > 10) disp = r.height / p.h;
    else if (r.width > 10 && r.height > 10) disp = Math.min(r.width / p.w, r.height / p.h);
    else disp = 1280 / Math.max(p.w, p.h);
    return clamp(disp * dpr * R.quality, 0.2, 1);
  }
  /** Size every working canvas. `full` = export resolution; otherwise preview resolution. */
  function applyPreset(full) {
    const p = PRESETS[S.preset];
    const sc = full === true ? 1 : previewScale(p);
    const w = Math.max(2, Math.round(p.w * sc / 2) * 2), h = Math.max(2, Math.round(p.h * sc / 2) * 2);
    R.renderScale = sc;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; R.snapReady = false; R.cEma = 0; }
    [cleanC, snapC, tmpC, chanC].forEach((c) => { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } });
    glowA.width = Math.max(8, Math.round(w / 8)); glowA.height = Math.max(8, Math.round(h / 8));
    glowB.width = Math.max(4, Math.round(w / 24)); glowB.height = Math.max(4, Math.round(h / 24));
    bg.width = 48; bg.height = Math.max(8, Math.round(48 * h / w));
    R.dirty = true;
  }
  /** Keep preview frame time under budget by trading resolution, never frames. */
  function adaptQuality(dt) {
    R.cEma = R.cEma ? R.cEma * 0.85 + dt * 0.15 : dt;
    const now = performance.now();
    if (now - (R.qT || 0) < 1200) return;
    const fps = R.src.fps ? R.src.fps.measured * S.speed : 60;
    const budget = Math.max(6, 1000 / Math.min(120, fps)) * 0.55;
    const tm = previewTiming();
    if (tm && tm.segIndex > 0 && tm.u < S.transDur + 0.2) return; // never resize mid-transition
    if (R.cEma > budget && R.quality > 0.35) { R.quality = Math.max(0.35, R.quality * 0.75); R.qT = now; applyPreset(); }
    else if (R.cEma < budget * 0.3 && R.quality < 1) { R.quality = Math.min(1, R.quality * 1.25); R.qT = now; applyPreset(); }
  }
  function swapSnap() {
    const t = snapC; snapC = cleanC; cleanC = t;
    R.snapReady = true;
  }
  function ensureTiles() {
    if (grainTiles) return;
    grainTiles = [0, 1, 2, 3].map((k) => {
      const c = mk(256, 256), g = c.getContext('2d');
      const img = g.createImageData(256, 256);
      const rnd = mulberry32(9001 + k * 77);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (rnd() - 0.5) * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c;
    });
    scanTile = mk(1, 4);
    const s = scanTile.getContext('2d');
    s.fillStyle = 'rgba(0,0,0,0.55)'; s.fillRect(0, 0, 1, 2);
  }

  // ---------- output frame rate ----------
  function fpsLabel(r) {
    if (!r) return '—';
    if (r.den === 1001) return (r.num / 1001).toFixed(r.num === 30000 || r.num === 60000 ? 2 : 3);
    return String(r.num / r.den);
  }
  function outRate() {
    if (S.outFps === 'match' || !S.outFps) {
      let r = R.src.fps && R.src.fps.rational;
      if (!r) return { num: 30, den: 1, fps: 30, assumed: true };
      if (r.fps > 60.5) r = r.den === 1001 ? { num: 60000, den: 1001, fps: 60000 / 1001 } : { num: 60, den: 1, fps: 60 };
      return r;
    }
    const c = FPS_CHOICES.find((x) => x[0] === String(S.outFps));
    if (c) return { num: c[1], den: c[2], fps: c[1] / c[2] };
    return { num: 30, den: 1, fps: 30 };
  }
  function srcFrameDur() { return R.src.fps ? 1 / R.src.fps.measured : 1 / 30; }

  // ---------- live audio graph (preview + real-time engine) ----------
  const A = { ctx: null };
  const musicEl = new Audio();
  musicEl.loop = true;
  musicEl.preload = 'auto';
  function ensureAudio() {
    if (A.ctx) return A.ctx.state === 'suspended' ? A.ctx.resume() : Promise.resolve();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.resolve();
    try {
      A.ctx = new AC({ latencyHint: 'playback' });
      A.src = A.ctx.createMediaElementSource(vA);
      A.game = A.ctx.createGain();
      A.musicSrc = A.ctx.createMediaElementSource(musicEl);
      A.music = A.ctx.createGain();
      A.master = A.ctx.createGain();
      A.monitor = A.ctx.createGain();
      A.dest = A.ctx.createMediaStreamDestination();
      A.bed = A.ctx.createGain(); // game + music bed (ducked under voice-over)
      A.src.connect(A.game).connect(A.bed);
      A.src2 = A.ctx.createMediaElementSource(vB);
      A.src2.connect(A.game);
      A.musicSrc.connect(A.music).connect(A.bed);
      A.bed.connect(A.master);
      A.voBus = A.ctx.createGain();
      A.voBus.connect(A.master);
      A.voChain = buildVoiceChain(A.ctx, A.voBus);
      A.master.connect(A.monitor).connect(A.ctx.destination);
      A.master.connect(A.dest);
    } catch (e) { console.warn('Audio graph unavailable', e); A.ctx = null; }
    return A.ctx ? A.ctx.resume() : Promise.resolve();
  }
  function updateLiveAudio(fadeA) {
    if (!A.ctx) return;
    const t = A.ctx.currentTime;
    A.game.gain.setTargetAtTime(S.muteGame ? 0 : S.gameVol / 100, t, 0.02);
    A.music.gain.setTargetAtTime(R.musicUrl ? S.musicVol / 100 : 0, t, 0.02);
    A.master.gain.setTargetAtTime(1 - (fadeA || 0), t, 0.015);
    const monitorOn = (!R.exporting || $('#monitorAudio').checked) && !(R.voRec && !S.voMonitor);
    A.monitor.gain.setTargetAtTime(monitorOn ? 1 : 0, t, 0.02);
  }
  /** Synthesized transition whoosh (filtered noise) — original, royalty-free. */
  function whoosh(ac, when, dur, dest) {
    const d = clamp(dur, 0.15, 1.2);
    const n = Math.floor(ac.sampleRate * d);
    const b = ac.createBuffer(1, n, ac.sampleRate);
    const ch = b.getChannelData(0), rnd = mulberry32(4242);
    for (let i = 0; i < n; i++) ch[i] = rnd() * 2 - 1;
    const src = ac.createBufferSource(); src.buffer = b;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.3;
    bp.frequency.setValueAtTime(300, when);
    bp.frequency.exponentialRampToValueAtTime(3800, when + d * 0.55);
    bp.frequency.exponentialRampToValueAtTime(650, when + d);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.5, when + d * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, when + d);
    src.connect(bp).connect(g).connect(dest);
    src.start(when); src.stop(when + d + 0.02);
  }

  // ---------- timing ----------
  function reelSegs() {
    const list = R.clips.length ? R.clips : [{ start: R.inPt, end: R.outPt }];
    return list.map((c, i) => ({ start: c.start, end: c.end, caption: c.caption || '', trans: i === 0 ? 'cut' : (c.trans && c.trans !== 'default' ? c.trans : S.transition) }));
  }
  function seqInfo(segs) {
    const offsets = []; let acc = 0;
    segs.forEach((s) => { offsets.push(acc); acc += (s.end - s.start) / S.speed; });
    return { segs, offsets, total: acc, i: 0 };
  }
  function previewTiming() {
    const fpsOut = outRate().fps;
    const q = R.exp || R.seq;
    if (q) {
      const seg = q.segs[q.i];
      const u = Math.max(0, (R.mediaTime - seg.start) / S.speed);
      const t = q.offsets[q.i] + u;
      return { t, T: q.total, u, segDur: (seg.end - seg.start) / S.speed, segIndex: q.i, n: Math.floor(t * fpsOut), trans: seg.trans, caption: seg.caption || '', src: R.mediaTime };
    }
    const mt = R.mediaTime;
    if (!R.ready || mt < R.inPt - 0.02 || mt > R.outPt + 0.05) return null;
    const u = (mt - R.inPt) / S.speed, T = (R.outPt - R.inPt) / S.speed;
    return { t: u, T, u, segDur: T, segIndex: 0, n: Math.floor(u * fpsOut), trans: 'cut', caption: '', src: mt };
  }
  function fadeAlpha(tm) {
    if (!tm) return 0;
    let a = 0;
    if (S.fadeIn > 0 && tm.t < S.fadeIn) a = 1 - tm.t / S.fadeIn;
    if (S.fadeOut > 0 && tm.t > tm.T - S.fadeOut) a = Math.max(a, (tm.t - (tm.T - S.fadeOut)) / S.fadeOut);
    return clamp(a, 0, 1);
  }

  // =====================================================================
  //  COMPOSITOR — shared by preview, real-time export and frame-exact export
  // =====================================================================
  function lookFilter() {
    if (!HAS_FILTER) return 'none';
    if (S.brightness === 100 && S.contrast === 100 && S.saturation === 100) return 'none';
    return 'brightness(' + S.brightness + '%) contrast(' + S.contrast + '%) saturate(' + S.saturation + '%)';
  }

  /**
   * @param {CanvasImageSource|null} src  video element or WebCodecs VideoFrame
   * @param {number} sw source width
   * @param {number} sh source height
   * @param {object|null} tm timing {t, T, u, segDur, segIndex, n, trans}
   * @param {{keepClean?: boolean}} [opts]
   */
  function compose(src, sw, sh, tm, opts) {
    opts = opts || {};
    const W = canvas.width, H = canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (HAS_FILTER) ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!src || !sw || !sh) { drawPlaceholder(W, H); ctx.restore(); return; }

    const look = lookFilter();
    const t = tm ? tm.t : 0;
    const minD = Math.min(W, H);

    // ---- motion effects (zoom / shake / mirror) ----
    let z = S.zoom / 100, ox = 0, oy = 0, rot = 0;
    if (tm) {
      if (S.fxPush) z *= 1 + (S.fxPushAmt / 100) * 0.2 * clamp(tm.u / Math.max(0.2, tm.segDur), 0, 1);
      if (S.fxImpact) z *= 1 + (S.fxImpactAmt / 100) * 0.35 * Math.exp(-tm.u * 6);
      if (S.fxShake) {
        const a = (S.fxShakeAmt / 100) * minD * 0.018;
        ox = a * (Math.sin(t * 37.1) + 0.6 * Math.sin(t * 19.3 + 1.7) + 0.35 * Math.sin(t * 83.9 + 0.4));
        oy = a * (Math.sin(t * 29.7 + 2.1) + 0.6 * Math.sin(t * 23.1 + 0.3) + 0.35 * Math.sin(t * 71.3 + 1.1));
        rot = (S.fxShakeAmt / 100) * 0.006 * Math.sin(t * 13.7);
        z *= 1 + (a * 2.6) / minD;
      }
    }

    // backdrop for "fit"
    if (S.frame === 'fit') {
      const bw = bg.width, bh = bg.height, bs = Math.max(bw / sw, bh / sh);
      bctx.drawImage(src, (bw - sw * bs) / 2, (bh - sh * bs) / 2, sw * bs, sh * bs);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      if (HAS_FILTER) ctx.filter = look;
      ctx.drawImage(bg, -W * 0.06, -H * 0.06, W * 1.12, H * 1.12);
      if (HAS_FILTER) ctx.filter = 'none';
      ctx.fillStyle = 'rgba(6,5,12,0.5)';
      ctx.fillRect(0, 0, W, H);
    }
    const base = S.frame === 'fit' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
    const s = base * z, dw = sw * s, dh = sh * s;
    let panX = S.panX / 100;
    if (S.autoReframe && R.ai && R.ai.track && S.frame === 'fill' && tm && tm.src != null && dw > W + 1) {
      const c = CHAI.trackAt(R.ai.track, tm.src);
      panX = clamp((W / 2 - (S.fxMirror ? 1 - c : c) * dw) / (W - dw), 0, 1);
    }
    const cx = (W - dw) * panX + dw / 2 + ox;
    const cy = (H - dh) * (S.panY / 100) + dh / 2 + oy;
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);
    if (S.fxMirror) ctx.scale(-1, 1);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (HAS_FILTER) ctx.filter = look;
    ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
    if (HAS_FILTER) ctx.filter = 'none';
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // ---- color & texture effects ----
    if (S.tintAmt > 0) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = S.tintAmt / 100;
      ctx.fillStyle = S.tint;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    if (S.fxGlow) applyGlow(W, H, S.fxGlowAmt / 100);
    if (S.fxRgb) rgbSplit(W, H, (S.fxRgbAmt / 100) * W * 0.008 * (S.fxImpact && tm ? 1 + 2 * Math.exp(-tm.u * 6) : 1));
    if (S.fxVhs) applyVhs(W, H, S.fxVhsAmt / 100, t, tm ? tm.n : 0);
    if (S.fxGrain) applyGrain(W, H, S.fxGrainAmt / 100, tm ? tm.n : Math.floor(performance.now() / 33));
    if (S.vignette > 0) {
      const g = ctx.createRadialGradient(W / 2, H / 2, minD * 0.32, W / 2, H / 2, Math.hypot(W, H) / 2);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,' + (S.vignette / 100) + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    if (S.bars) {
      const bar = W >= H ? Math.max(0, (H - W / 2.39) / 2) : H * 0.085;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
    }
    if (S.fxBwEnd && tm && tm.T - tm.t < S.fxBwEndDur) {
      const p = clamp(1 - (tm.T - tm.t) / S.fxBwEndDur, 0, 1);
      ctx.globalCompositeOperation = 'saturation';
      ctx.globalAlpha = easeOut(p);
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // ---- keep a clean copy (pre-transition, pre-text) for the next clip's transition ----
    if (opts.keepClean) {
      const cc = cleanC.getContext('2d');
      cc.globalCompositeOperation = 'copy';
      cc.drawImage(canvas, 0, 0);
      cc.globalCompositeOperation = 'source-over';
    }

    // ---- transition from previous clip's last frame ----
    if (tm && tm.segIndex > 0 && tm.trans && tm.trans !== 'cut' && R.snapReady && tm.u < S.transDur) {
      applyTransition(tm.trans, clamp(tm.u / S.transDur, 0, 1), snapC, tm.n, W, H);
    }

    drawCaption(W, H, tm);
    drawSubs(W, H, tm);
    drawHandle(W, H);

    const fa = fadeAlpha(tm);
    if (fa > 0) {
      ctx.fillStyle = 'rgba(0,0,0,' + fa + ')';
      ctx.fillRect(0, 0, W, H);
    }
    if (!R.exporting || R.exp) updateLiveAudio(R.exp || (tm && !video.paused) ? fa : 0);
    if (S.safe && !R.exporting && !R.aipOn) drawSafeZones(W, H);
    ctx.restore();
  }

  function copyToTmp() {
    tctx.globalCompositeOperation = 'copy';
    tctx.drawImage(canvas, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
  }
  function applyGlow(W, H, amt) {
    // bloom is built on a 1/8-size canvas, then composited in ONE full-size pass
    gaCtx.globalCompositeOperation = 'copy';
    if (HAS_FILTER) gaCtx.filter = 'brightness(1.1) contrast(1.6) blur(' + Math.max(1, glowA.width / 160).toFixed(2) + 'px)';
    gaCtx.drawImage(canvas, 0, 0, glowA.width, glowA.height);
    if (HAS_FILTER) gaCtx.filter = 'none';
    let src = glowA;
    if (!HAS_FILTER) { gbCtx.globalCompositeOperation = 'copy'; gbCtx.drawImage(glowA, 0, 0, glowB.width, glowB.height); src = glowB; }
    ctx.globalCompositeOperation = 'screen';
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = amt * 0.85;
    ctx.drawImage(src, 0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  function rgbSplit(W, H, px) {
    if (px < 0.5) return;
    copyToTmp();
    // keep green in place (one fill instead of a full copy), then add shifted red and blue
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, W, H);
    [['#ff0000', -px], ['#0000ff', px]].forEach((c) => {
      chctx.globalCompositeOperation = 'copy';
      chctx.drawImage(tmpC, 0, 0);
      chctx.globalCompositeOperation = 'multiply';
      chctx.fillStyle = c[0];
      chctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(chanC, c[1], 0);
    });
    ctx.globalCompositeOperation = 'source-over';
  }
  function applyGrain(W, H, amt, n) {
    ensureTiles();
    const rnd = mulberry32(n * 2654435761);
    const tile = grainTiles[n & 3];
    const pat = ctx.createPattern(tile, 'repeat');
    const sc = Math.max(0.25, W / 1920);
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = amt * 0.55;
    ctx.translate(rnd() * 256, rnd() * 256);
    ctx.scale(sc, sc);
    ctx.fillStyle = pat;
    ctx.fillRect(-512, -512, W / sc + 1024, H / sc + 1024);
    ctx.restore();
  }
  function applyVhs(W, H, amt, t, n) {
    ensureTiles();
    rgbSplit(W, H, W * 0.0025 * amt + 1);
    // slight desaturation + warm bleed
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = 0.25 * amt;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    // scanlines
    const pat = ctx.createPattern(scanTile, 'repeat');
    ctx.save();
    const sc = Math.max(0.35, H / 720);
    ctx.scale(sc, sc);
    ctx.globalAlpha = 0.35 * amt;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W / sc, H / sc);
    ctx.restore();
    // rolling tracking band
    const y = ((t * 0.18) % 1.3) * H - H * 0.15;
    const g = ctx.createLinearGradient(0, y, 0, y + H * 0.12);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,' + (0.08 * amt) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W, H * 0.12);
    // occasional line jitter
    const rnd = mulberry32(n * 31 + 7);
    if (rnd() < 0.15 * amt) {
      const jy = rnd() * H, jh = H * (0.01 + rnd() * 0.03);
      ctx.drawImage(canvas, 0, jy, W, jh, (rnd() - 0.5) * W * 0.03 * amt, jy, W, jh);
    }
  }

  function applyTransition(type, p, Aimg, n, W, H) {
    const e = easeIO(p);
    ctx.save();
    switch (type) {
      case 'fade':
        ctx.globalAlpha = 1 - e;
        ctx.drawImage(Aimg, 0, 0);
        break;
      case 'black':
      case 'white': {
        const col = type === 'black' ? '#000' : '#fff';
        if (p < 0.5) {
          ctx.drawImage(Aimg, 0, 0);
          ctx.globalAlpha = type === 'white' ? Math.pow(p * 2, 1.6) : p * 2;
        } else {
          ctx.globalAlpha = type === 'white' ? Math.pow(2 - p * 2, 2.2) : 2 - p * 2;
        }
        ctx.fillStyle = col;
        ctx.fillRect(0, 0, W, H);
        break;
      }
      case 'slide':
        copyToTmp();
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(Aimg, -W * e, 0);
        ctx.drawImage(tmpC, W * (1 - e), 0);
        break;
      case 'push':
        copyToTmp();
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(Aimg, 0, -H * e);
        ctx.drawImage(tmpC, 0, H * (1 - e));
        break;
      case 'wipe': {
        const x = W * e;
        ctx.beginPath(); ctx.rect(x, 0, W - x, H); ctx.clip();
        ctx.drawImage(Aimg, 0, 0);
        ctx.restore(); ctx.save();
        const bw = W * 0.025;
        const g = ctx.createLinearGradient(x - bw, 0, x + bw, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.65)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - bw, 0, bw * 2, H);
        break;
      }
      case 'zoom': {
        copyToTmp();
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        const sb = 1.3 - 0.3 * e;
        ctx.globalAlpha = Math.min(1, e * 1.6);
        ctx.drawImage(tmpC, (W - W * sb) / 2, (H - H * sb) / 2, W * sb, H * sb);
        const sa = 1 + 0.9 * e;
        ctx.globalAlpha = 1 - e;
        ctx.drawImage(Aimg, (W - W * sa) / 2, (H - H * sa) / 2, W * sa, H * sa);
        break;
      }
      case 'whip': {
        copyToTmp();
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        const blur = Math.sin(Math.PI * p), steps = 8;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 1 / steps;
        for (let i = 0; i < steps; i++) {
          const f = (i / (steps - 1) - 0.5) * W * 0.16 * blur;
          ctx.drawImage(Aimg, -W * e + f, 0);
          ctx.drawImage(tmpC, W * (1 - e) + f, 0);
        }
        break;
      }
      case 'glitch': {
        copyToTmp();
        const rnd = mulberry32(n * 7919 + 13);
        const baseImg = p < 0.5 ? Aimg : tmpC, other = p < 0.5 ? tmpC : Aimg;
        ctx.drawImage(baseImg, 0, 0);
        const k = 1 - Math.abs(2 * p - 1);
        const bands = 8 + Math.floor(rnd() * 10);
        for (let i = 0; i < bands; i++) {
          const y = rnd() * H, h = (0.01 + rnd() * 0.08) * H;
          const dx = (rnd() - 0.5) * W * 0.18 * k;
          ctx.drawImage(rnd() < 0.5 ? other : baseImg, 0, y, W, h, dx, y, W, h);
        }
        ctx.restore();
        rgbSplit(W, H, W * 0.014 * k);
        ctx.save();
        break;
      }
      case 'iris': {
        copyToTmp();
        ctx.drawImage(Aimg, 0, 0);
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, Math.max(1, e * Math.hypot(W, H) / 2), 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(tmpC, 0, 0);
        break;
      }
      default: break;
    }
    ctx.restore();
  }

  function drawPlaceholder(W, H) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#120c22'); g.addColorStop(0.6, '#2a0f2e'); g.addColorStop(1, '#3a1420');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const r = Math.min(W, H) * 0.18;
    const sg = ctx.createLinearGradient(0, H * 0.4, 0, H * 0.4 + r * 2);
    sg.addColorStop(0, 'rgba(255,178,43,.35)'); sg.addColorStop(1, 'rgba(255,61,129,.15)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(W / 2, H * 0.62, r, Math.PI, 0); ctx.fill();
    if (S.safe) drawSafeZones(W, H);
  }

  function wrapLines(text, maxW) {
    const out = [];
    text.split('\n').forEach((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      let line = '';
      words.forEach((w) => {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
      });
      if (line) out.push(line);
    });
    return out.slice(0, 4);
  }

  function drawCaption(W, H, tm) {
    let raw = (S.caption || '').trim();
    let local = tm ? tm.t : 999; // seconds since caption appeared
    const perClip = !!(tm && tm.caption && tm.caption.trim());
    if (perClip) { raw = tm.caption.trim(); local = tm.u; }
    if (!raw) return;
    if (!perClip && S.captionTiming !== 'always' && tm) {
      if (S.captionTiming === 'first' && tm.t > 4) return;
      if (S.captionTiming === 'last') { if (tm.t < tm.T - 4) return; local = tm.t - (tm.T - 4); }
    }
    let txt = S.captionUpper ? raw.toUpperCase() : raw;
    const vertical = H > W;
    let size = Math.round(Math.min(W, H) * S.captionSize / 100);
    // entrance animation
    let alpha = 1, dy = 0, scale = 1;
    if (S.captionAnim === 'pop') { const p = clamp(local / 0.35, 0, 1); scale = p < 1 ? 0.6 + 0.4 * (1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2)) : 1; alpha = clamp(p * 2, 0, 1); }
    else if (S.captionAnim === 'slide') { const p = easeOut(clamp(local / 0.45, 0, 1)); dy = (1 - p) * size * 1.4; alpha = p; }
    else if (S.captionAnim === 'type') { const chars = Math.floor(local * 22); if (chars < txt.length) txt = txt.slice(0, Math.max(0, chars)); }
    if (!txt) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '900 ' + size + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fullLines = wrapLines(S.captionUpper ? raw.toUpperCase() : raw, W * 0.84);
    const lines = S.captionAnim === 'type' ? wrapLines(txt, W * 0.84) : fullLines;
    const lh = size * 1.18;
    const nLines = fullLines.length;
    let y0;
    if (S.captionPos === 'top') y0 = H * (vertical ? 0.16 : 0.1) + lh / 2;
    else if (S.captionPos === 'middle') y0 = H / 2 - (nLines - 1) * lh / 2;
    else y0 = H * (vertical ? 0.7 : 0.86) - (nLines - 1) * lh;
    const cx = W / 2;
    const midY = y0 + (nLines - 1) * lh / 2;
    if (scale !== 1) { ctx.translate(cx, midY); ctx.scale(scale, scale); ctx.translate(-cx, -midY); }
    ctx.translate(0, dy);
    lines.forEach((ln, i) => {
      const y = y0 + i * lh;
      if (S.captionStyle === 'box') {
        const tw = ctx.measureText(ln).width, pad = size * 0.32;
        ctx.fillStyle = 'rgba(8,6,14,0.78)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(cx - tw / 2 - pad, y - lh / 2, tw + pad * 2, lh, size * 0.18);
        else ctx.rect(cx - tw / 2 - pad, y - lh / 2, tw + pad * 2, lh);
        ctx.fill();
        ctx.fillStyle = S.captionColor;
        ctx.fillText(ln, cx, y + size * 0.04);
      } else if (S.captionStyle === 'glow') {
        ctx.shadowColor = S.captionColor;
        ctx.shadowBlur = size * 0.7;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(ln, cx, y);
        ctx.shadowBlur = size * 0.25;
        ctx.fillText(ln, cx, y);
        ctx.shadowBlur = 0;
      } else {
        ctx.lineJoin = 'round'; ctx.miterLimit = 2;
        ctx.lineWidth = size * 0.17;
        ctx.strokeStyle = 'rgba(0,0,0,0.92)';
        ctx.strokeText(ln, cx, y);
        ctx.fillStyle = S.captionColor;
        ctx.fillText(ln, cx, y);
      }
    });
    ctx.restore();
  }

  function drawHandle(W, H) {
    const h = (S.handle || '').trim().replace(/^@+/, '');
    if (!h) return;
    const vertical = H > W;
    const size = Math.round(Math.min(W, H) * 0.034);
    const m = Math.min(W, H) * 0.045;
    ctx.save();
    ctx.font = '800 ' + size + 'px ' + FONT;
    ctx.textBaseline = 'middle';
    const right = S.handleCorner[1] === 'r', bottom = S.handleCorner[0] === 'b';
    ctx.textAlign = right ? 'right' : 'left';
    const x = right ? W - m - (vertical ? W * 0.12 : 0) : m;
    const y = bottom ? H - m - size / 2 - (vertical ? H * 0.17 : 0) : m + size / 2 + (vertical ? H * 0.06 : 0);
    ctx.globalAlpha = 0.9;
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = size * 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('@' + h, x, y);
    ctx.restore();
  }

  function drawSafeZones(W, H) {
    const lw = Math.max(2, Math.min(W, H) * 0.003);
    ctx.save();
    ctx.setLineDash([lw * 6, lw * 4]);
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(34,216,224,0.9)';
    ctx.fillStyle = 'rgba(255,61,129,0.16)';
    ctx.font = '700 ' + Math.round(Math.min(W, H) * 0.024) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (H > W) {
      ctx.fillRect(0, 0, W, H * 0.06);
      ctx.fillRect(0, H * 0.8, W, H * 0.2);
      ctx.fillRect(W * 0.86, H * 0.42, W * 0.14, H * 0.38);
      ctx.strokeRect(W * 0.04, H * 0.06, W * 0.82, H * 0.74);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText('Platform UI: keep text out', W / 2, H * 0.9);
    } else {
      ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);
      ctx.fillRect(0, H * 0.9, W, H * 0.1);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText('Player controls area', W / 2, H * 0.95);
    }
    ctx.restore();
  }

  // =====================================================================
  //  PREVIEW PLAYBACK (frame-accurate: one draw per decoded source frame)
  // =====================================================================
  function renderFromVideo() {
    if (!R.ready) { compose(null); return; }
    if (video.seeking || video.readyState < 2 || !video.videoWidth) return; // hold last frame while seeking
    const t0 = performance.now();
    const tmNow = previewTiming();
    if (R.metrics && R.metrics.advanceAt && tmNow && R.seq && tmNow.segIndex === R.seq.i) {
      R.metrics.boundaries.push(+(t0 - R.metrics.advanceAt).toFixed(1)); // boundary → first frame of the next clip
      R.metrics.advanceAt = 0;
    }
    compose(video, video.videoWidth, video.videoHeight, tmNow, { keepClean: !!(R.seq || R.exp) });
    R.dirty = false;
    if (!video.paused && !R.exp && !R.exporting) adaptQuality(performance.now() - t0);
  }

  function vfcLoop(el) {
    const cb = (now, meta) => {
      if (el === video) {
        R.mediaTime = meta.mediaTime;
        if (!el.paused) R.fpsWindow.n++;
        handlePlaybackFrame();
      }
      el.requestVideoFrameCallback(cb);
    };
    el.requestVideoFrameCallback(cb);
  }
  if (HAS_RVFC) { vfcLoop(vA); vfcLoop(vB); }

  function handlePlaybackFrame() {
    if (R.exporting && !R.exp) return; // the frame-exact engine owns the canvas
    if (R.exp) { renderFromVideo(); return; }
    if (!video.paused) {
      if (R.seq) {
        const q = R.seq;
        if (q.waiting) return;
        const seg = q.segs[q.i];
        if (R.mediaTime >= seg.end - srcFrameDur() * 0.5 || video.ended) { seqAdvance(); return; }
        if (q.stopAt && currentOutT() >= q.stopAt) { q.stopAt = 0; renderFromVideo(); video.pause(); return; }
      } else if (S.loop && R.outPt > R.inPt && R.mediaTime >= R.outPt) {
        video.currentTime = R.inPt;
        R.mediaTime = R.inPt;
        if (R.musicUrl) syncMusicToVideo();
        return;
      }
    }
    renderFromVideo();
  }

  function startSeq() {
    if (!R.ready || R.exporting) return;
    const segs = reelSegs();
    if (!segs.length) return;
    R.seq = Object.assign(seqInfo(segs), { waiting: true });
    R.snapReady = false;
    video.pause();
    video.currentTime = segs[0].start;
    prepareStandby();
    ensureAudio().then(() => video.play().catch(() => {}));
    toast(segs.length > 1 ? 'Playing reel with transitions' : 'Playing range');
  }
  function seqAdvance() {
    const q = R.seq;
    if (R.metrics) R.metrics.advanceAt = performance.now();
    swapSnap();
    q.i++;
    if (q.i >= q.segs.length) { R.seq = null; video.pause(); R.dirty = true; if (R.voRec) stopVoRecording(); if (R.aipOn) R.aipT = q.total; return; }
    const nx = q.segs[q.i];
    if (!video.paused && standbyReady(q.i, nx.start)) {
      // instant swap: the next clip's first frame is already decoded on the standby element
      const old = video;
      video = standby;
      standby = old;
      R.swapping = true;
      old.pause();
      R.mediaTime = video.currentTime;
      q.waiting = false;
      video.playbackRate = S.speed;
      video.play().catch(() => {}).finally(() => { R.swapping = false; });
      R.standbyFor = -1;
      R.swaps = (R.swaps || 0) + 1;
      renderFromVideo();
      prepareStandby();
    } else if (!video.paused && R.standbyFor === q.i && R.standbyAt === nx.start && standby.seeking) {
      // the standby decoder is already part-way through this seek: wait for it rather than starting over
      q.waiting = true;
      R.awaitStandby = true;
      R.resumeAfterStandby = true;
      video.pause();
    } else {
      q.waiting = true;
      video.currentTime = nx.start;
    }
    if (S.transSfx && nx.trans !== 'cut' && A.ctx) whoosh(A.ctx, A.ctx.currentTime, S.transDur, A.master);
  }
  function finishStandbySwap() {
    const q = R.seq;
    R.awaitStandby = false;
    if (!q) return;
    const nx = q.segs[q.i];
    if (!standbyReady(q.i, nx.start)) { video.currentTime = nx.start; return; }
    const old = video;
    video = standby;
    standby = old;
    old.pause();
    R.mediaTime = video.currentTime;
    q.waiting = false;
    video.playbackRate = S.speed;
    R.standbyFor = -1;
    R.swaps = (R.swaps || 0) + 1;
    renderFromVideo();
    if (R.resumeAfterStandby) video.play().catch(() => {});
    R.resumeAfterStandby = false;
    prepareStandby();
  }
  [vA, vB].forEach((el) => el.addEventListener('seeked', (e) => { if (e.target === standby && R.awaitStandby) finishStandbySwap(); }));
  /** Pre-seek the hidden decoder to the start of the next reel clip. */
  function prepareStandby() {
    const q = R.seq;
    R.standbyFor = -1;
    if (!q || !standby.getAttribute('src')) return;
    const nx = q.segs[q.i + 1];
    if (!nx) return;
    standby.pause();
    standby.playbackRate = S.speed;
    if (Math.abs(standby.currentTime - nx.start) > 0.0005 || standby.readyState < 2) standby.currentTime = nx.start;
    R.standbyFor = q.i + 1;
    R.standbyAt = nx.start;
  }
  function standbyReady(i, t) {
    return R.standbyFor === i && R.standbyAt === t && !standby.seeking && standby.readyState >= 2 && Math.abs(standby.currentTime - t) < 0.05;
  }
  function stopSeq() { if (R.seq) { R.seq = null; R.dirty = true; } R.standbyFor = -1; R.awaitStandby = false; R.resumeAfterStandby = false; standby.pause(); }

  function rafLoop() {
    if (R.ready && (!R.exporting || R.exp)) {
      if (!HAS_RVFC && !video.paused) { R.mediaTime = video.currentTime; handlePlaybackFrame(); }
      else if (video.paused && R.dirty && !R.exp && !(R.seq && R.seq.waiting)) { R.mediaTime = video.currentTime; renderFromVideo(); }
    } else if (!R.ready && R.dirty) { compose(null); R.dirty = false; }
    updatePlayhead();
    updateFpsMeter();
    updateRecUi();
    if (R.aipOn) drawAip();
    requestAnimationFrame(rafLoop);
  }

  function updateFpsMeter() {
    const el = $('#fpsMeter');
    const now = performance.now();
    const w = R.fpsWindow;
    if (!R.ready || video.paused || R.exporting) { el.hidden = true; w.t = now; w.n = 0; return; }
    if (now - w.t >= 1000) {
      w.fps = w.n * 1000 / (now - w.t);
      const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
      const dropped = q ? q.droppedVideoFrames : 0;
      w.dropNow = dropped - (w.dropped || 0);
      w.dropped = dropped;
      w.t = now; w.n = 0;
      const target = R.src.fps ? R.src.fps.measured * S.speed : null;
      el.hidden = !HAS_RVFC;
      el.textContent = 'Preview ' + w.fps.toFixed(1) + (target ? ' / ' + target.toFixed(2) : '') + ' fps · ' + canvas.width + '×' + canvas.height + (w.dropNow > 0 ? ' · ' + w.dropNow + ' dropped' : '');
      el.classList.toggle('warn', !!(target && w.fps < target * 0.9));
    }
  }

  // ---------- file loading ----------
  function loadFile(file) {
    if (!file) return;
    if (R.exporting) { toast('Wait for the render to finish first.', true); return; }
    const okType = (file.type || '').indexOf('video') === 0 || /\.(mp4|m4v|mov|webm|mkv|ogv)$/i.test(file.name);
    if (!okType) { toast('That file doesn\'t look like a video.', true); return; }
    if (R.url) URL.revokeObjectURL(R.url);
    R.loadToken++;
    R.file = file;
    R.url = URL.createObjectURL(file);
    R.ready = false;
    R.clips = [];
    R.seq = null;
    R.demux = null; R.demuxState = 'idle'; R.exactOk = false; R.fullAudio = null;
    R.src = { fps: null, vfr: false, width: 0, height: 0, vcodec: '', acodec: '' };
    renderClips();
    $('#fileName').textContent = file.name + ' · ' + fmtBytes(file.size);
    $('#srcInfo').textContent = 'Analyzing…';
    vA.pause(); vB.pause();
    video = vA; standby = vB;
    R.standbyFor = -1;
    vA.src = R.url; vA.load();
    vB.src = R.url; vB.load();
    analyzeSource(file, R.loadToken);
  }

  vA.addEventListener('loadedmetadata', function () {
    const fin = () => {
      R.duration = video.duration;
      R.inPt = 0;
      R.outPt = R.duration;
      R.ready = true;
      R.mediaTime = 0;
      R.dirty = true;
      video.playbackRate = S.speed;
      $('#dropzone').hidden = true;
      $('#tlRange').hidden = false;
      setEnabled(true);
      drawRuler();
      updateMarks();
      buildThumbs();
      toast('Footage loaded. Find your moment and mark it.');
    };
    if (!isFinite(video.duration)) {
      video.currentTime = 1e101;
      once(video, 'durationchange', 5000).catch(() => {}).then(() => { video.currentTime = 0; fin(); });
    } else fin();
  });
  const onActive = (type, fn) => [vA, vB].forEach((el) => el.addEventListener(type, (e) => { if (e.target === video) fn(e); }));
  onActive('seeked', () => {
    R.mediaTime = video.currentTime;
    R.dirty = true;
    if (R.seq) { R.seq.waiting = false; if (R.standbyFor !== R.seq.i + 1) prepareStandby(); }
    if (!video.paused && !R.exporting) { rescheduleVo(); if (R.seq && R.musicUrl) syncMusicToVideo(); }
  });
  onActive('seeking', () => { if (!R.exp) stopVo(); });
  vA.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    R.ready = false;
    $('#dropzone').hidden = false;
    setEnabled(false);
    toast('Your browser can\'t decode this file. Try MP4 (H.264) or WebM, or open it in Chrome/Edge.', true);
  });
  onActive('play', () => {
    $('#btnPlay').textContent = '❚❚';
    if (R.swapping) return; // seamless clip swap: music and voice-over keep running untouched
    if (!R.exporting) R.mediaTime = video.currentTime;
    if (!R.exporting && R.musicUrl) syncMusicToVideo(true);
    if (!R.exporting) rescheduleVo();
  });
  onActive('pause', () => {
    $('#btnPlay').textContent = '▶';
    if (!R.exporting) musicEl.pause();
    stopVo();
    R.dirty = true;
  });

  async function analyzeSource(file, token) {
    R.demuxState = 'loading';
    R.demuxPromise = (async () => {
      try {
        const dm = await CHDemux.open(file, (p) => { if (token === R.loadToken) $('#srcInfo').textContent = 'Indexing frames… ' + Math.round(p * 100) + '%'; });
        if (token !== R.loadToken) return;
        R.demux = dm;
        if (dm.video) {
          R.src.width = dm.video.width; R.src.height = dm.video.height;
          R.src.vcodec = dm.video.codecName || dm.video.codec || '';
          if (dm.video.fpsInfo) { R.src.fps = dm.video.fpsInfo; R.src.vfr = dm.video.fpsInfo.vfr; }
        }
        if (dm.audio) R.src.acodec = dm.audio.codecName || dm.audio.codec || '';
      } catch (e) {
        console.warn('Demux failed:', e);
        R.demux = null;
      }
      if (token !== R.loadToken) return;
      if (!R.src.fps) R.src.fps = await probeFpsByPlayback(file);
      // engine availability
      let ok = false, reason = '';
      if (!window.CHExact || !CHExact.supported()) reason = 'This browser doesn\'t support WebCodecs';
      else if (!R.demux || !R.demux.video) reason = 'Couldn\'t index this container';
      else if (!(await CHExact.videoDecoderConfig(R.demux.video))) reason = (R.src.vcodec || 'This codec') + ' can\'t be decoded with WebCodecs here';
      else ok = true;
      if (token !== R.loadToken) return;
      R.exactOk = ok; R.exactReason = reason;
      R.demuxState = 'ready';
      updateSrcInfo();
      buildFpsOptions();
      syncControls();
    })();
    return R.demuxPromise;
  }

  async function probeFpsByPlayback(file) {
    if (!HAS_RVFC) return null;
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = R.url;
    try {
      await once(v, 'loadeddata', 8000);
      const times = [];
      await new Promise((resolve) => {
        const cb = (now, meta) => { times.push(meta.mediaTime); if (times.length < 45) v.requestVideoFrameCallback(cb); else resolve(); };
        v.requestVideoFrameCallback(cb);
        v.play().catch(resolve);
        setTimeout(resolve, 4000);
      });
      v.pause();
      v.removeAttribute('src'); v.load();
      const info = CHDemux.analyzeFps(times.sort((a, b) => a - b));
      void file;
      return info;
    } catch (e) { return null; }
  }

  function updateSrcInfo() {
    const parts = [];
    if (R.src.width) parts.push(R.src.width + '×' + R.src.height);
    else if (video.videoWidth) parts.push(video.videoWidth + '×' + video.videoHeight);
    if (R.src.fps) parts.push(fpsLabel(R.src.fps.rational) + ' fps' + (R.src.vfr ? ' (variable)' : ''));
    if (R.src.vcodec) parts.push(R.src.vcodec + (R.src.acodec ? ' + ' + R.src.acodec : ''));
    parts.push(R.exactOk ? '✓ Frame-exact' : 'Real-time engine');
    $('#srcInfo').textContent = parts.join(' · ');
    $('#srcInfo').title = R.exactOk ? 'Exports decode every source frame with WebCodecs' : (R.exactReason || '');
  }

  function buildFpsOptions() {
    const sel = $('#fpsSel');
    const r = R.src.fps && R.src.fps.rational;
    let label = 'Match source';
    if (r) {
      label += ' (' + fpsLabel(r) + (r.fps > 60.5 ? ' → ' + fpsLabel(outRateForMatch(r)) : '') + ')';
    }
    sel.innerHTML = '<option value="match">' + label + '</option>' + FPS_CHOICES.map((c) => '<option value="' + c[0] + '">' + c[0] + ' fps</option>').join('');
    sel.value = S.outFps;
    updateFpsHint();
  }
  function outRateForMatch(r) { return r.den === 1001 ? { num: 60000, den: 1001 } : { num: 60, den: 1 }; }
  function updateFpsHint() {
    const h = $('#fpsHint');
    const out = outRate();
    const src = R.src.fps;
    if (!src) { h.textContent = R.ready ? 'Couldn\'t detect the source frame rate, so output defaults to ' + fpsLabel(out) + ' fps.' : 'Load a clip to detect its frame rate.'; return; }
    const sr = src.rational;
    let txt;
    if (sr.num === out.num && sr.den === out.den) txt = 'Output matches the source exactly: one output frame per source frame, with no drops or duplicates.';
    else if (sr.fps > out.fps) txt = 'Source is ' + fpsLabel(sr) + ' fps, so frames are thinned evenly to ' + fpsLabel(out) + ' fps.';
    else txt = 'Source is ' + fpsLabel(sr) + ' fps. Output at ' + fpsLabel(out) + ' fps repeats frames on an even cadence.';
    if (src.vfr) txt += ' The source uses a variable frame rate, so the output is converted to a constant rate.';
    if (S.speed !== 1) txt += ' At ' + S.speed + '× speed, frames are sampled from the source timeline.';
    h.textContent = txt;
  }
  function updateEngineHint() {
    const h = $('#engineHint');
    if (!R.ready) { h.textContent = 'Frame-exact rendering decodes every frame with WebCodecs and doesn\'t rely on real-time playback.'; return; }
    if (R.demuxState === 'loading') { h.textContent = 'Analyzing source…'; return; }
    if (S.engine === 'realtime' || S.container === 'webm') h.textContent = 'Real-time capture records while the clip plays. It\'s slower, and timing depends on your computer keeping up.';
    else if (R.exactOk) h.textContent = '✓ Every frame is decoded and encoded in order, and audio is mixed sample-accurately at 48 kHz.';
    else h.textContent = 'Frame-exact rendering isn\'t available for this file (' + R.exactReason + '). Real-time capture will be used instead.';
  }

  function syncMusicToVideo(play) {
    if (!R.musicUrl) return;
    const rel = R.seq ? Math.max(0, currentOutT()) : Math.max(0, (video.currentTime - R.inPt) / S.speed);
    const d = musicEl.duration;
    let t = S.musicStart + rel;
    if (isFinite(d) && d > 0) t = t % d;
    try { musicEl.currentTime = t; } catch (e) { /* not ready */ }
    if (play || !video.paused) musicEl.play().catch(() => {});
  }

  function setEnabled(on) {
    $$('.quick-marks button, #btnSetIn, #btnSetOut, #btnAddClip, #btnPlay, [data-step], #btnSnap, #btnPreviewTrans, #btnAiEdit, #btnVoRecord').forEach((b) => { b.disabled = !on; });
    $('#btnExport').disabled = !on;
  }

  // ---------- thumbnails & ruler ----------
  function buildThumbs() {
    const token = ++R.thumbsToken;
    const wrap = $('#thumbs');
    wrap.innerHTML = '';
    const n = clamp(Math.round(timeline.clientWidth / 96), 6, 18);
    const cells = [];
    for (let i = 0; i < n; i++) { const d = document.createElement('div'); d.className = 'thumb'; wrap.appendChild(d); cells.push(d); }
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.src = R.url;
    const c = document.createElement('canvas');
    const cx = c.getContext('2d');
    (async () => {
      try { await once(v, 'loadeddata', 10000); } catch (e) { return; }
      c.width = 160;
      c.height = Math.round(160 * (v.videoHeight || 9) / (v.videoWidth || 16));
      for (let k = 0; k < n; k++) {
        if (token !== R.thumbsToken) break;
        v.currentTime = Math.min(R.duration - 0.05, (k + 0.5) * R.duration / n);
        try { await once(v, 'seeked', 6000); } catch (e) { continue; }
        cx.drawImage(v, 0, 0, c.width, c.height);
        cells[k].style.backgroundImage = 'url(' + c.toDataURL('image/jpeg', 0.6) + ')';
      }
      v.removeAttribute('src');
      v.load();
    })();
  }
  function drawRuler() {
    const r = $('#ruler');
    r.innerHTML = '';
    const d = R.duration;
    if (!d) return;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    const target = d / Math.max(4, Math.floor(timeline.clientWidth / 90));
    const step = steps.find((s) => s >= target) || 3600;
    for (let t = 0; t <= d + 0.001; t += step) {
      const sp = document.createElement('span');
      sp.style.left = (t / d * 100) + '%';
      sp.textContent = fmt(t, false);
      r.appendChild(sp);
    }
  }

  // ---------- marks / timeline ----------
  function setIn(t) { R.inPt = clamp(t, 0, Math.max(0, R.outPt - 0.1)); updateMarks(); }
  function setOut(t) { R.outPt = clamp(t, R.inPt + 0.1, R.duration); updateMarks(); }
  function seek(t) { video.currentTime = clamp(t, 0, R.duration || 0); }
  function updateMarks() {
    $('#inLabel').textContent = fmt(R.inPt);
    $('#outLabel').textContent = fmt(R.outPt);
    const d = R.duration || 1;
    const range = $('#tlRange');
    range.style.left = (R.inPt / d * 100) + '%';
    range.style.width = ((R.outPt - R.inPt) / d * 100) + '%';
    if (!R.clips.length) $('#reelDur').textContent = fmt((R.outPt - R.inPt) / S.speed, false);
    R.dirty = true;
  }
  function updatePlayhead() {
    if (!R.ready) return;
    const ct = video.currentTime;
    $('#playhead').style.left = (ct / (R.duration || 1) * 100) + '%';
    $('#timecode').innerHTML = fmt(ct) + ' <span>/ ' + fmt(R.duration) + '</span>';
  }
  function timeAt(ev) {
    const r = timeline.getBoundingClientRect();
    return clamp((ev.clientX - r.left) / r.width, 0, 1) * R.duration;
  }
  timeline.addEventListener('pointerdown', (e) => {
    if (!R.ready || R.exporting) return;
    stopSeq();
    const h = e.target.dataset ? e.target.dataset.h : null;
    timeline.setPointerCapture(e.pointerId);
    const wasPlaying = !video.paused;
    if (wasPlaying) video.pause();
    const move = (ev) => {
      const t = timeAt(ev);
      if (h === 'in') { setIn(t); seek(R.inPt); }
      else if (h === 'out') { setOut(t); seek(R.outPt); }
      else seek(t);
    };
    move(e);
    const up = () => {
      timeline.removeEventListener('pointermove', move);
      timeline.removeEventListener('pointerup', up);
      timeline.removeEventListener('pointercancel', up);
      if (wasPlaying && !h) video.play().catch(() => {});
    };
    timeline.addEventListener('pointermove', move);
    timeline.addEventListener('pointerup', up);
    timeline.addEventListener('pointercancel', up);
  });

  // ---------- reel ----------
  function addClip() {
    if (!R.ready) return;
    if (R.outPt - R.inPt < 0.2) { toast('Range is too short.', true); return; }
    R.clips.push({ id: R.nextClipId++, start: R.inPt, end: R.outPt, trans: 'default' });
    renderClips();
    toast('Clip ' + R.clips.length + ' added to reel.');
  }
  function reelDuration() {
    return reelSegs().reduce((a, c) => a + (c.end - c.start), 0) / S.speed;
  }
  function transOptions(sel) {
    return '<option value="default"' + (sel === 'default' ? ' selected' : '') + '>↳ Default (' + TRANS_LABEL[S.transition] + ')</option>' +
      TRANSITIONS.map((t) => '<option value="' + t.id + '"' + (sel === t.id ? ' selected' : '') + '>↳ ' + t.label + '</option>').join('');
  }
  function renderClips() {
    const ol = $('#clipList');
    ol.innerHTML = '';
    R.clips.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'clip';
      const color = CLIP_COLORS[i % CLIP_COLORS.length];
      li.innerHTML =
        (i > 0 ? '<select class="trans-sel" title="Transition into this clip">' + transOptions(c.trans || 'default') + '</select>' : '') +
        '<div class="clip-row"><span class="clip-n" style="background:' + color + '">' + (i + 1) + '</span>' +
        '<button type="button" class="clip-main" data-act="go" title="Preview this clip"><b>' + fmt(c.start) + ' → ' + fmt(c.end) + '</b>' +
        '<small>' + (c.end - c.start).toFixed(2) + 's</small></button>' +
        '<div class="clip-act">' +
        '<button type="button" data-act="up" title="Move up" aria-label="Move up">↑</button>' +
        '<button type="button" data-act="down" title="Move down" aria-label="Move down">↓</button>' +
        '<button type="button" data-act="del" title="Remove" aria-label="Remove">✕</button></div></div>' +
        '<input class="clip-cap" type="text" maxlength="60" placeholder="Clip caption (optional)" value="' + esc(c.caption || '') + '">' +
        (c.ai ? '<div class="clip-ai">✨ ' + esc(c.ai.reasons.join(' · ')) + '</div>' : '');
      li.dataset.id = c.id;
      ol.appendChild(li);
    });
    $('#clipEmpty').hidden = R.clips.length > 0;
    $('#reelActions').hidden = R.clips.length === 0;
    $('#reelDur').textContent = fmt(reelDuration(), false);
    const cuts = Math.max(0, R.clips.length - 1);
    $('#transCount').textContent = cuts + (cuts === 1 ? ' cut' : ' cuts');
    const segs = $('#tlSegs');
    segs.innerHTML = '';
    const d = R.duration || 1;
    R.clips.forEach((c, i) => {
      const s = document.createElement('div');
      s.className = 'tl-seg';
      s.style.left = (c.start / d * 100) + '%';
      s.style.width = ((c.end - c.start) / d * 100) + '%';
      s.style.background = CLIP_COLORS[i % CLIP_COLORS.length];
      segs.appendChild(s);
    });
  }
  $('#clipList').addEventListener('input', (e) => {
    const inp = e.target.closest('.clip-cap');
    if (!inp) return;
    const c = R.clips.find((x) => String(x.id) === inp.closest('.clip').dataset.id);
    if (c) { c.caption = inp.value; R.dirty = true; }
  });
  $('#clipList').addEventListener('change', (e) => {
    const sel = e.target.closest('.trans-sel');
    if (!sel) return;
    const li = sel.closest('.clip');
    const c = R.clips.find((x) => String(x.id) === li.dataset.id);
    if (c) { c.trans = sel.value; previewTransition(R.clips.indexOf(c)); }
  });
  $('#clipList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || R.exporting) return;
    const li = btn.closest('.clip');
    const idx = R.clips.findIndex((c) => String(c.id) === li.dataset.id);
    if (idx < 0) return;
    const act = btn.dataset.act;
    if (act === 'del') R.clips.splice(idx, 1);
    else if (act === 'up' && idx > 0) R.clips.splice(idx - 1, 0, R.clips.splice(idx, 1)[0]);
    else if (act === 'down' && idx < R.clips.length - 1) R.clips.splice(idx + 1, 0, R.clips.splice(idx, 1)[0]);
    else if (act === 'go') {
      stopSeq();
      const c = R.clips[idx];
      R.inPt = c.start; R.outPt = c.end;
      updateMarks();
      seek(c.start);
      ensureAudio().then(() => video.play().catch(() => {}));
      return;
    }
    renderClips();
  });
  $('#btnClearReel').addEventListener('click', () => {
    if (!R.clips.length || !confirm('Remove all clips from the reel?')) return;
    R.clips = [];
    stopSeq();
    renderClips();
    updateMarks();
  });
  $('#btnPlayReel').addEventListener('click', startSeq);
  $('#btnPreviewTrans').addEventListener('click', () => {
    if (R.clips.length < 2) { toast('Add at least two clips to the reel to see transitions.', true); return; }
    startSeq();
  });

  // ---------- transport ----------
  function togglePlay() {
    if (!R.ready || R.exporting) return;
    if (R.awaitStandby) { R.resumeAfterStandby = !R.resumeAfterStandby; return; }
    ensureAudio().then(() => {
      if (video.paused) {
        if (!R.seq && S.loop && (video.currentTime >= R.outPt - 0.05 || video.currentTime < R.inPt)) video.currentTime = R.inPt;
        video.play().catch((err) => toast('Playback blocked: ' + err.message, true));
      } else video.pause();
    });
  }
  function step(delta) {
    if (!R.ready || R.exporting) return;
    stopSeq();
    if (!video.paused) video.pause();
    seek(video.currentTime + delta);
  }
  function stepFrames(n) { step(n * srcFrameDur()); }
  $('#btnPlay').addEventListener('click', togglePlay);
  $$('[data-step]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.step;
      if (v === 'frame') stepFrames(1);
      else if (v === '-frame') stepFrames(-1);
      else step(parseFloat(v));
    });
  });
  $$('.quick-marks button').forEach((b) => {
    b.addEventListener('click', () => {
      stopSeq();
      const back = parseFloat(b.dataset.back);
      const end = video.currentTime > 0.2 ? video.currentTime : Math.min(R.duration, back);
      R.outPt = end;
      R.inPt = Math.max(0, end - back);
      updateMarks();
      seek(R.inPt);
      toast('Marked ' + fmt(R.inPt) + ' → ' + fmt(R.outPt));
    });
  });
  $('#btnSetIn').addEventListener('click', () => setIn(video.currentTime));
  $('#btnSetOut').addEventListener('click', () => setOut(video.currentTime));
  $('#btnAddClip').addEventListener('click', addClip);
  $('#btnSnap').addEventListener('click', snapshot);

  function snapshot() {
    if (!R.ready) return;
    const wasSafe = S.safe;
    S.safe = false;
    R.mediaTime = video.currentTime;
    applyPreset(true); // thumbnails at full resolution
    renderFromVideo();
    canvas.toBlob((b) => {
      S.safe = wasSafe;
      applyPreset();
      R.dirty = true;
      if (!b) return;
      downloadBlob(b, slug(S.title || baseName()) + '-thumb-' + Math.round(video.currentTime * 100) + '.png');
      toast('Frame saved as a PNG. Use it as your thumbnail.');
    }, 'image/png');
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#exportModal').hidden) { if (e.key === 'Escape' && !R.exporting) closeModal(); return; }
    if (!$('#aiModal').hidden) {
      if (e.key === 'Escape' && !R.aiBusy) closeAi();
      else if ((e.key === ' ' || e.key.toLowerCase() === 'k') && R.aipOn) { e.preventDefault(); aipTogglePlay(); }
      else if (e.key === 'ArrowLeft' && R.aipOn) { e.preventDefault(); aipJumpClip(-1); }
      else if (e.key === 'ArrowRight' && R.aipOn) { e.preventDefault(); aipJumpClip(1); }
      return;
    }
    if (!R.ready) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'i') setIn(video.currentTime);
    else if (k === 'o') setOut(video.currentTime);
    else if (k === 'a') addClip();
    else if (k === 'r') startSeq();
    else if (k === 'v') toggleVoRecording();
    else if (k === 'p') snapshot();
    else if (k === 'j') step(-5);
    else if (k === 'l') step(5);
    else if (k === 'arrowleft') { e.preventDefault(); if (e.shiftKey) step(-1); else stepFrames(-1); }
    else if (k === 'arrowright') { e.preventDefault(); if (e.shiftKey) step(1); else stepFrames(1); }
  });

  // ---------- file input / drag & drop ----------
  const fileInput = $('#fileInput');
  $('#btnOpen').addEventListener('click', () => fileInput.click());
  $('#dropzone').addEventListener('click', () => fileInput.click());
  $('#dropzone').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (/^audio\//.test(f.type)) loadMusic(f); else loadFile(f);
  });

  // ---------- music ----------
  function loadMusic(file) {
    if (!file) return;
    if (R.musicUrl) URL.revokeObjectURL(R.musicUrl);
    R.musicUrl = URL.createObjectURL(file);
    R.musicFile = file;
    R.musicBuf = null;
    musicEl.src = R.musicUrl;
    musicEl.load();
    $('#musicName').textContent = '♫ ' + file.name;
    $('#btnRemoveMusic').hidden = false;
    ensureAudio();
    toast('Music added. Adjust the mix on the Audio tab.');
  }
  $('#musicInput').addEventListener('change', (e) => { loadMusic(e.target.files[0]); e.target.value = ''; });
  $('#btnRemoveMusic').addEventListener('click', () => {
    musicEl.pause();
    musicEl.removeAttribute('src');
    musicEl.load();
    if (R.musicUrl) URL.revokeObjectURL(R.musicUrl);
    R.musicUrl = null; R.musicFile = null; R.musicBuf = null;
    $('#musicName').textContent = 'No music added.';
    $('#btnRemoveMusic').hidden = true;
  });

  // ---------- inspector bindings ----------
  function buildPresetGrid() {
    const grid = $('#presetGrid');
    Object.keys(PRESETS).forEach((k) => {
      const p = PRESETS[k];
      const sc = Math.min(34 / p.w, 20 / p.h);
      const lab = document.createElement('label');
      lab.className = 'preset';
      lab.innerHTML = '<input type="radio" name="preset" value="' + k + '" data-bind="preset">' +
        '<span class="ar"><i style="width:' + Math.round(p.w * sc) + 'px;height:' + Math.round(p.h * sc) + 'px"></i></span>' +
        '<b>' + p.name + '</b><small>' + p.size + '</small>';
      grid.appendChild(lab);
    });
  }
  function buildLookChips() {
    const wrap = $('#lookChips');
    Object.keys(LOOKS).forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip look-chip';
      b.dataset.look = k;
      b.innerHTML = '<i style="background:' + LOOKS[k].dot + '"></i>' + LOOKS[k].label;
      b.addEventListener('click', () => { Object.assign(S, LOOKS[k].v); S.look = k; R.dirty = true; syncControls(); saveSettings(); });
      wrap.appendChild(b);
    });
  }
  function buildFx() {
    const list = $('#fxList');
    EFFECTS.forEach((ef) => {
      const row = document.createElement('div');
      row.className = 'fx-row';
      let amt = '';
      if (ef.amt === true) amt = '<div class="fx-amt"><input type="range" min="0" max="100" data-bind="fx' + ef.id + 'Amt" aria-label="' + ef.label + ' amount"><output data-out="fx' + ef.id + 'Amt" data-unit="%"></output></div>';
      else if (ef.amt === 'dur') amt = '<div class="fx-amt"><input type="range" min="0.5" max="4" step="0.1" data-bind="fxBwEndDur" aria-label="Duration"><output data-out="fxBwEndDur" data-unit="s"></output></div>';
      row.innerHTML = '<label class="fx-toggle" title="' + ef.tip + '"><input type="checkbox" data-bind="fx' + ef.id + '"><span class="sw"></span>' + ef.label + '</label>' + amt;
      list.appendChild(row);
    });
    const pres = $('#fxPresets');
    Object.keys(FX_PRESETS).forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = FX_PRESETS[k].label;
      b.addEventListener('click', () => {
        const pr = FX_PRESETS[k];
        EFFECTS.forEach((ef) => { S['fx' + ef.id] = false; });
        Object.keys(pr.on).forEach((id) => { S['fx' + id] = true; S['fx' + id + 'Amt'] = pr.on[id]; });
        if (pr.extra) Object.assign(S, pr.extra);
        if (k === 'none') S.bars = false;
        R.dirty = true;
        syncControls(); saveSettings();
        toast(pr.label + ' effects applied');
      });
      pres.appendChild(b);
    });
    const grid = $('#transGrid');
    TRANSITIONS.forEach((t) => {
      const lab = document.createElement('label');
      lab.className = 'trans-card';
      lab.innerHTML = '<input type="radio" name="transition" value="' + t.id + '" data-bind="transition"><i>' + t.icon + '</i><span>' + t.label + '</span>';
      grid.appendChild(lab);
    });
  }
  function buildTagChips() {
    const wrap = $('#tagChips');
    wrap.innerHTML = '';
    const current = parseTags().map((t) => t.toLowerCase());
    (CFG.suggestedHashtags || []).forEach((tag) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (current.indexOf(tag.replace(/^#/, '').toLowerCase()) >= 0 ? ' on' : '');
      b.textContent = tag;
      b.addEventListener('click', () => {
        const t = tag.replace(/^#/, '');
        const list = parseTags();
        const i = list.findIndex((x) => x.toLowerCase() === t.toLowerCase());
        if (i >= 0) list.splice(i, 1); else list.push(t);
        S.tags = list.map((x) => '#' + x).join(' ');
        R.tagsBuilt = null;
        syncControls(); saveSettings();
      });
      wrap.appendChild(b);
    });
  }

  function syncControls() {
    $$('[data-bind]').forEach((el) => {
      const k = el.dataset.bind;
      const v = S[k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'radio') el.checked = String(el.value) === String(v);
      else if (document.activeElement !== el || el.type === 'range') el.value = v;
    });
    $$('[data-out]').forEach((o) => {
      const k = o.dataset.out;
      const v = S[k];
      const dec = /^fade|transDur|fxBwEndDur/.test(k) ? 2 : 1;
      o.textContent = (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(dec)) : v) + (o.dataset.unit || '');
    });
    $$('#lookChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.look === S.look));
    $$('.fx-row').forEach((row) => { const cb = row.querySelector('input[type=checkbox]'); row.classList.toggle('on', !!(cb && cb.checked)); });
    const tc = $('#titleCount');
    tc.textContent = (S.title || '').length + '/100';
    tc.classList.toggle('over', (S.title || '').length > 100);
    $('#filterHint').hidden = HAS_FILTER;
    if (R.tagsBuilt !== S.tags) { R.tagsBuilt = S.tags; buildTagChips(); }
    updateFpsHint();
    updateEngineHint();
    $$('.trans-sel').forEach((sel) => { const o = sel.querySelector('option[value=default]'); if (o) o.textContent = '↳ Default (' + TRANS_LABEL[S.transition] + ')'; });
  }

  function bindControls() {
    $$('[data-bind]').forEach((el) => {
      const k = el.dataset.bind;
      const evName = (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(evName, () => {
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'radio') { if (!el.checked) return; v = el.value; }
        else if (el.type === 'range' || el.type === 'number') v = parseFloat(el.value);
        else v = el.value;
        if (el.hasAttribute('data-num')) v = parseFloat(v);
        S[k] = v;
        onSetting(k);
      });
    });
  }
  function onSetting(k) {
    if (LOOK_KEYS.indexOf(k) >= 0) S.look = 'custom';
    if (k === 'preset') applyPreset();
    if (k === 'speed') { video.playbackRate = S.speed; renderClips(); updateMarks(); }
    if (k === 'frame' && S.frame === 'fit' && S.zoom > 100) S.zoom = 100;
    if (k === 'voPolish' || k === 'voFilter') rebuildLiveVoiceChain();
    if ((k === 'voDuck' || k === 'voSubs') && !video.paused) rescheduleVo();
    if (k === 'aiStyle' && R.ai) { drawHeat(); drawAiGraph(); }
    if (k === 'transition' || k === 'transDur') {
      clearTimeout(R.transPrevT);
      R.transPrevT = setTimeout(() => {
        const i = R.clips.findIndex((c, j) => j > 0 && (!c.trans || c.trans === 'default'));
        previewTransition(i > 0 ? i : 1);
      }, 280);
    }
    if (k === 'autoReframe' && S.autoReframe && !(R.ai && R.ai.track)) toast('Run AI Edit → Analyze footage first so ClipHeist can follow the action.', true);
    R.dirty = true;
    syncControls();
    saveSettings();
  }
  $('#btnRecenter').addEventListener('click', () => { S.zoom = 100; S.panX = 50; S.panY = 50; R.dirty = true; syncControls(); saveSettings(); });

  $$('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b ? 'true' : 'false'));
      $$('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
    });
  });

  // ---------- post text ----------
  function parseTags() {
    const seen = {};
    return String(S.tags || '').split(/[\s,]+/).map((t) => t.replace(/^#+/, '').trim())
      .filter((t) => { if (!t) return false; const key = t.toLowerCase(); if (seen[key]) return false; seen[key] = 1; return true; });
  }
  function baseName() { return R.file ? R.file.name.replace(/\.[^.]+$/, '') : 'clip'; }
  function isVertical() { const p = PRESETS[S.preset]; return p.h > p.w; }
  function captionText(platform) {
    const tags = parseTags();
    if ((platform === 'shorts' || (platform === 'youtube' && isVertical())) && !tags.some((t) => t.toLowerCase() === 'shorts')) tags.push('Shorts');
    return [S.title.trim(), S.description.trim(), tags.map((t) => '#' + t).join(' ')].filter(Boolean).join('\n\n');
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
    return Promise.resolve();
  }
  $('#btnCopyCaption').addEventListener('click', () => copyText(captionText()).then(() => toast('Caption copied.')));

  // =====================================================================
  //  EXPORT
  // =====================================================================
  const MP4_TYPES = ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4;codecs=avc1', 'video/mp4'];
  const WEBM_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm'];
  function pickMime(pref) {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    const order = pref === 'webm' ? WEBM_TYPES.concat(MP4_TYPES) : MP4_TYPES.concat(WEBM_TYPES);
    return order.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }
  function mimeLabel(m) {
    if (!m) return 'Not supported';
    if (m.indexOf('mp4') >= 0) return 'MP4 (H.264' + (m.indexOf('mp4a') >= 0 ? ' + AAC' : m.indexOf('opus') >= 0 ? ' + Opus' : '') + ')';
    if (m.indexOf('vp9') >= 0) return 'WebM (VP9 + Opus)';
    if (m.indexOf('vp8') >= 0) return 'WebM (VP8 + Opus)';
    return 'WebM';
  }
  function engineWanted() { return S.engine !== 'realtime' && S.container !== 'webm'; }

  const modal = $('#exportModal');
  function showStep(id) { ['stepConfirm', 'stepRender', 'stepDone'].forEach((s) => { $('#' + s).hidden = s !== id; }); }
  async function openExport() {
    if (!R.ready) return;
    applyPreset(); // canvas must always match the chosen output size
    video.pause();
    stopSeq();
    if (R.demuxState === 'loading') { toast('Analyzing source…'); await R.demuxPromise; }
    const total = reelDuration();
    const p = PRESETS[S.preset];
    const rate = outRate();
    const exact = engineWanted() && R.exactOk;
    const mime = exact ? 'video/mp4' : pickMime(S.container);
    const estMB = (S.bitrate * total / 8) + (0.192 * total / 8);
    const frames = Math.round(total * rate.fps);
    const segs = reelSegs();
    const transUsed = segs.slice(1).filter((s) => s.trans !== 'cut').map((s) => TRANS_LABEL[s.trans]);
    const fxOn = EFFECTS.filter((e) => S['fx' + e.id]).map((e) => e.label);
    const rows = [
      ['Format', p.name + ' · ' + p.w + '×' + p.h],
      ['Frame rate', fpsLabel(rate) + ' fps · ' + frames + ' frames' + (R.src.fps && R.src.fps.rational.num === rate.num && R.src.fps.rational.den === rate.den ? ' (matches source)' : '')],
      ['Length', fmt(total) + (R.clips.length ? ' · ' + R.clips.length + ' clip' + (R.clips.length > 1 ? 's' : '') : ' · In/Out range') + (S.speed !== 1 ? ' · ' + S.speed + '×' : '')],
      ['Engine', exact ? 'Frame-exact (WebCodecs)' : 'Real-time capture'],
      ['File', (exact ? 'MP4 (H.264 + AAC/Opus)' : mimeLabel(mime)) + ' · ' + S.bitrate + ' Mbps · ~' + estMB.toFixed(estMB < 10 ? 1 : 0) + ' MB'],
      ['Effects', fxOn.length ? fxOn.join(', ') : 'None'],
      ['Transitions', transUsed.length ? transUsed.length + ' (' + Array.from(new Set(transUsed)).join(', ') + ', ' + S.transDur + 's)' : (segs.length > 1 ? 'Hard cuts' : '—')],
      ['Audio', (S.muteGame ? 'Game muted' : 'Game ' + S.gameVol + '%') + (R.musicUrl ? ' + music ' + S.musicVol + '%' : '') + (S.transSfx && transUsed.length ? ' + whooshes' : '') +
        (activeVos().length ? ' + voice-over (' + activeVos().length + (activeVos().length > 1 ? ' takes' : ' take') + (S.voDuck > 0 ? ', ducking ' + S.voDuck + ' dB' : '') + ')' : '')]
    ];
    const dl = $('#exportSummary');
    dl.innerHTML = '';
    rows.forEach((r) => {
      const dt = document.createElement('dt'); dt.textContent = r[0];
      const dd = document.createElement('dd'); dd.textContent = r[1];
      dl.appendChild(dt); dl.appendChild(dd);
    });
    const notes = [];
    if (!exact && !mime) notes.push(['', '<b>Your browser can\'t render video.</b> Open ClipHeist in the latest Chrome or Edge on a desktop.']);
    if (!exact && engineWanted() && !R.exactOk) notes.push(['', '<b>Using real-time capture:</b> ' + R.exactReason + '. Keep this tab visible while it renders. Chrome or Edge with an MP4 source gives you frame-exact exports.']);
    if (R.src.vfr) notes.push(['info', 'The source uses a <b>variable frame rate</b>, which is common for phone and console captures. The export converts it to a constant ' + fpsLabel(rate) + ' fps so platforms play it smoothly.']);
    if (isVertical() && total > 180) notes.push(['', '<b>Longer than 3 minutes.</b> YouTube won\'t treat this as a Short. TikTok and Reels may also cap length.']);
    if (!S.muteGame && !R.musicUrl) notes.push(['info', 'Tip: if this clip includes in-game radio, mute game audio on the Audio tab to avoid copyright claims.']);
    $('#exportNotes').innerHTML = notes.map((n) => '<div class="note ' + n[0] + '" style="margin-bottom:10px">' + n[1] + '</div>').join('');
    $('#monitorWrap').hidden = exact;
    $('#btnStartRender').disabled = !exact && !mime;
    showStep('stepConfirm');
    modal.hidden = false;
    if (window.YTUpload) YTUpload.preload();
  }
  function closeModal() {
    if (R.exporting) {
      if (!confirm('Cancel the render in progress?')) return;
      R.cancel = true;
    }
    modal.hidden = true;
  }
  $('#btnExport').addEventListener('click', openExport);
  $('#modalClose').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal && !R.exporting) closeModal(); });
  $('#btnCancelRender').addEventListener('click', () => { R.cancel = true; });
  $('#btnStartRender').addEventListener('click', () => {
    startRender().catch((err) => {
      console.error(err);
      R.exporting = false; R.exp = null; R.dirty = true;
      showStep('stepConfirm');
      toast('Render failed: ' + (err && err.message ? err.message : err), true);
    });
  });

  const rp = $('#renderPreview');
  const rpCtx = rp.getContext('2d');
  function setProgress(frac, status, eta) {
    if (frac != null) $('#progressBar').style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
    if (status != null) $('#renderStatus').textContent = status;
    if (eta != null) $('#renderEta').textContent = eta;
  }
  let lastPreviewDraw = 0;
  function drawRenderPreview(force) {
    const now = performance.now();
    if (!force && now - lastPreviewDraw < 150) return;
    lastPreviewDraw = now;
    const W = canvas.width, H = canvas.height;
    const sc = Math.min(rp.width / W, rp.height / H);
    rpCtx.fillStyle = '#000';
    rpCtx.fillRect(0, 0, rp.width, rp.height);
    rpCtx.drawImage(canvas, (rp.width - W * sc) / 2, (rp.height - H * sc) / 2, W * sc, H * sc);
  }

  async function startRender() {
    const segs = reelSegs();
    const total = segs.reduce((a, s) => a + (s.end - s.start), 0) / S.speed;
    if (total < 0.2) throw new Error('Clip is too short.');
    if (R.result) { URL.revokeObjectURL(R.result.url); R.result = null; }
    R.downloaded = false;
    applyPreset(true); // export renders at full output resolution
    showStep('stepRender');
    setProgress(0, 'Preparing…', '');
    R.exporting = true;
    R.cancel = false;
    video.pause();
    musicEl.pause();
    stopSeq();
    let res = null;
    try {
      if (engineWanted() && R.exactOk) {
        $('#renderNote').textContent = 'Frame-exact render: every frame is decoded, composed and encoded in order. You can switch tabs; this doesn\'t depend on playback.';
        try {
          res = await renderExact(segs, total);
        } catch (e) {
          if (e && e.cancelled) res = null;
          else if (e && e.unsupported) {
            toast('Frame-exact export unavailable (' + e.message + '). Using real-time capture.', true);
          } else throw e;
        }
      }
      if (!res && !R.cancel) {
        $('#renderNote').textContent = 'Real-time capture: keep this tab open and visible. Your browser records the clip as it plays.';
        res = await renderRealtime(segs, total);
      }
    } finally {
      R.exporting = false;
      R.exp = null;
      R.dirty = true;
      video.playbackRate = S.speed;
      applyPreset(); // back to preview resolution
    }
    if (R.cancel || !res) {
      R.cancel = false;
      showStep('stepConfirm');
      toast('Render cancelled.');
      return;
    }
    R.result = res;
    R.result.url = URL.createObjectURL(res.blob);
    R.result.name = slug(S.title || baseName()) + '-' + S.preset + '.' + res.ext;
    showDone();
  }

  // ---- frame-exact engine ----
  async function renderExact(segs, total) {
    const rate = outRate();
    const r = await CHExact.render({
      file: R.file, demux: R.demux, segs, speed: S.speed, rate,
      width: canvas.width, height: canvas.height, bitrate: S.bitrate * 1e6, canvas,
      compose: (frame, tm, isLast) => compose(frame, frame.displayWidth, frame.displayHeight, tm, { keepClean: isLast }),
      onSegmentStart: (i) => { if (i === 0) R.snapReady = false; },
      onSegmentEnd: () => swapSnap(),
      mixAudio: () => mixAudioOffline(segs, total),
      isCancelled: () => R.cancel,
      onProgress: (p) => {
        if (p.phase === 'audio') setProgress(0, 'Mixing audio (48 kHz, sample-accurate)…', '');
        else if (p.phase === 'video') {
          setProgress(p.frame / p.total, 'Frame ' + p.frame + ' / ' + p.total + ' · ' + p.fps.toFixed(0) + ' fps', fmt(p.eta, false) + ' left');
          drawRenderPreview();
        } else if (p.phase === 'encode-audio') setProgress(1, 'Encoding audio…', '');
        else if (p.phase === 'finalize') { setProgress(1, 'Writing MP4…', ''); drawRenderPreview(true); }
      }
    });
    return {
      blob: r.blob, type: 'video/mp4', ext: 'mp4', engine: 'exact', duration: r.total,
      frames: r.frames, expectedFrames: r.expectedFrames, rate: r.rate, frameMap: r.frameMap,
      codecs: 'H.264' + (r.audioCodec ? ' + ' + (r.audioCodec === 'aac' ? 'AAC' : 'Opus') : ''), seconds: r.seconds
    };
  }

  async function musicBuffer() {
    if (!R.musicFile) return null;
    if (R.musicBuf) return R.musicBuf;
    const ac = new OfflineAudioContext(2, 1, 48000);
    R.musicBuf = await ac.decodeAudioData(await R.musicFile.arrayBuffer());
    return R.musicBuf;
  }
  async function sourceAudioRange(start, end) {
    try {
      if (!R.demux) { const e = new Error('Container not indexed'); e.unsupported = true; throw e; }
      return await CHExact.decodeAudioRange(R.file, R.demux, start, end);
    } catch (e) {
      if (!e || !e.unsupported) throw e;
      // fallback: decode the whole file's audio once with the browser's audio decoder
      if (!R.fullAudio) {
        if (R.file.size > 1.5e9) throw e;
        const ac = new OfflineAudioContext(2, 1, 48000);
        R.fullAudio = await ac.decodeAudioData(await R.file.arrayBuffer());
      }
      const fa = R.fullAudio, sr = fa.sampleRate;
      const s0 = Math.max(0, Math.round(start * sr)), len = Math.max(1, Math.round((end - start) * sr));
      const out = new AudioBuffer({ length: len, numberOfChannels: fa.numberOfChannels, sampleRate: sr });
      for (let c = 0; c < fa.numberOfChannels; c++) out.getChannelData(c).set(fa.getChannelData(c).subarray(s0, Math.min(fa.length, s0 + len)));
      return out;
    }
  }
  /** Sample-accurate offline mix: game audio per clip + music + transition SFX + fades. */
  async function mixAudioOffline(segs, total) {
    const rate = 48000;
    const len = Math.max(1, Math.ceil(total * rate));
    const hasSrc = !!(R.demux && R.demux.audio);
    const useGame = hasSrc && !S.muteGame && S.gameVol > 0;
    const useMusic = !!R.musicFile && S.musicVol > 0;
    const info = seqInfo(segs);
    const sfx = S.transSfx ? segs.map((s, i) => (i > 0 && s.trans !== 'cut' ? info.offsets[i] : null)).filter((x) => x != null) : [];
    if (!useGame && !useMusic && !sfx.length && !activeVos().length) return null;
    const oac = new OfflineAudioContext(2, len, rate);
    const master = oac.createGain();
    master.connect(oac.destination);
    const bed = oac.createGain(); // game + music, ducked under voice-over
    bed.connect(master);
    const g = master.gain;
    g.setValueAtTime(S.fadeIn > 0 ? 0 : 1, 0);
    if (S.fadeIn > 0) g.linearRampToValueAtTime(1, Math.min(S.fadeIn, total / 2));
    if (S.fadeOut > 0 && total > S.fadeOut) { g.setValueAtTime(1, Math.max(Math.min(S.fadeIn, total / 2), total - S.fadeOut)); g.linearRampToValueAtTime(0, total); }
    if (useGame) {
      const bus = oac.createGain();
      bus.gain.value = S.gameVol / 100;
      bus.connect(bed);
      for (let i = 0; i < segs.length; i++) {
        if (R.cancel) return null;
        const s = segs[i];
        setProgress(0, 'Decoding game audio ' + (i + 1) + '/' + segs.length + '…', '');
        const buf = await sourceAudioRange(s.start, s.end);
        if (!buf) continue;
        const off = info.offsets[i], segOut = (s.end - s.start) / S.speed;
        const src = oac.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = S.speed;
        const sg = oac.createGain();
        const dip = i > 0 && (s.trans === 'black' || s.trans === 'white');
        const rampIn = dip ? Math.min(S.transDur, segOut) / 2 : 0.012;
        sg.gain.setValueAtTime(0, off);
        sg.gain.linearRampToValueAtTime(1, off + rampIn);
        sg.gain.setValueAtTime(1, Math.max(off + rampIn, off + segOut - 0.012));
        sg.gain.linearRampToValueAtTime(0, off + segOut);
        src.connect(sg).connect(bus);
        src.start(off);
        src.stop(off + segOut + 0.02);
      }
    }
    if (useMusic) {
      setProgress(0, 'Decoding music…', '');
      const mb = await musicBuffer();
      if (mb) {
        const src = oac.createBufferSource();
        src.buffer = mb; src.loop = true;
        const mg = oac.createGain();
        mg.gain.value = S.musicVol / 100;
        src.connect(mg).connect(bed);
        src.start(0, (S.musicStart % mb.duration) || 0);
      }
    }
    mixVoOffline(oac, master, bed, total);
    sfx.forEach((t) => whoosh(oac, t, S.transDur, master));
    setProgress(0, 'Mixing audio (48 kHz)…', '');
    return await oac.startRendering();
  }

  // ---- real-time engine (compatibility) ----
  function seekTo(t) {
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - t) < 0.001 && video.readyState >= 2) { resolve(); return; }
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      video.addEventListener('seeked', finish, { once: true });
      setTimeout(finish, 4000);
      video.currentTime = t;
    });
  }
  function waitUntil(cond, tick) {
    return new Promise((resolve) => {
      const id = setInterval(() => { if (tick) tick(); if (cond()) { clearInterval(id); resolve(); } }, 15);
    });
  }
  async function renderRealtime(segs, total) {
    await ensureAudio();
    const mime = pickMime(S.container);
    if (!mime) throw new Error('This browser can\'t record video. Use the latest Chrome or Edge.');
    const rate = outRate();
    const stream = canvas.captureStream(rate.fps);
    const audioTrack = A.dest ? A.dest.stream.getAudioTracks()[0] : null;
    if (audioTrack) stream.addTrack(audioTrack);
    let rec;
    const recOpts = { mimeType: mime, videoBitsPerSecond: Math.round(S.bitrate * 1e6), audioBitsPerSecond: 192000 };
    try { rec = new MediaRecorder(stream, recOpts); }
    catch (e) { delete recOpts.mimeType; rec = new MediaRecorder(stream, recOpts); }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    video.playbackRate = S.speed;
    if (R.musicUrl) { try { musicEl.currentTime = S.musicStart; } catch (e) { /* ignore */ } }
    R.exp = Object.assign(seqInfo(segs), { i: 0 });
    R.snapReady = false;
    const t0 = performance.now();
    try {
      for (let i = 0; i < segs.length && !R.cancel; i++) {
        const seg = segs[i];
        R.exp.i = i;
        await seekTo(seg.start);
        R.mediaTime = video.currentTime;
        renderFromVideo();
        if (rec.state === 'inactive') rec.start(1000); else if (rec.state === 'paused') rec.resume();
        if (R.musicUrl) musicEl.play().catch(() => {});
        if (i > 0 && S.transSfx && seg.trans !== 'cut' && A.ctx) whoosh(A.ctx, A.ctx.currentTime, S.transDur, A.master);
        await video.play();
        const off = R.exp.offsets[i];
        scheduleVoAt(off);
        await waitUntil(() => R.cancel || video.ended || video.currentTime >= seg.end - srcFrameDur() * 0.5, () => {
          const done = off + Math.max(0, video.currentTime - seg.start) / S.speed;
          setProgress(done / total, (segs.length > 1 ? 'Clip ' + (i + 1) + '/' + segs.length + ' · ' : '') + Math.round(done / total * 100) + '% · real-time', fmt(Math.max(0, total - done), false) + ' left');
          drawRenderPreview();
        });
        video.pause();
        if (R.musicUrl) musicEl.pause();
        if (rec.state === 'recording') rec.pause();
        swapSnap();
      }
    } finally {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      stream.getVideoTracks().forEach((t) => t.stop());
      if (audioTrack) stream.removeTrack(audioTrack);
    }
    if (R.cancel) return null;
    const type = (rec.mimeType || mime).split(';')[0];
    const blob = new Blob(chunks, { type });
    if (!blob.size) throw new Error('The recorder produced an empty file.');
    return {
      blob, type, ext: type.indexOf('mp4') >= 0 ? 'mp4' : 'webm', engine: 'realtime', duration: total,
      frames: null, rate, codecs: mimeLabel(rec.mimeType || mime), seconds: (performance.now() - t0) / 1000
    };
  }

  function showDone() {
    const r = R.result;
    const p = PRESETS[S.preset];
    $('#resultVideo').src = r.url;
    let meta = r.name + ' · ' + fmtBytes(r.blob.size) + ' · ' + p.w + '×' + p.h + ' · ' + fmt(r.duration) + ' · ' + r.codecs;
    if (r.engine === 'exact') {
      meta += '\n✓ ' + r.frames + ' frames at a constant ' + fpsLabel(r.rate) + ' fps, frame-exact' + (r.frames === r.expectedFrames ? '' : ' (expected ' + r.expectedFrames + ')') + ' · rendered in ' + r.seconds.toFixed(1) + 's';
    } else {
      meta += '\nReal-time capture at ~' + fpsLabel(r.rate) + ' fps';
    }
    $('#resultMeta').textContent = meta;
    const file = new File([r.blob], r.name, { type: r.type });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    $('#btnNativeShare').hidden = !canShare;
    $('#shareMain').classList.toggle('one', !canShare);
    $('#formatWarn').innerHTML = r.ext === 'webm'
      ? '<div class="note" style="margin-top:12px">Exported as <b>WebM</b>. YouTube, X and Discord accept it. TikTok and Instagram need MP4, so for those, re-export with the frame-exact engine in Chrome or Edge.</div>'
      : '';
    const wrap = $('#platforms');
    wrap.innerHTML = '';
    PLATFORMS.forEach((pl) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<i style="background:' + pl.color + '"></i>' + pl.name;
      b.addEventListener('click', () => postTo(pl));
      wrap.appendChild(b);
    });
    const yt = window.YTUpload && YTUpload.isConfigured();
    $('#ytReady').hidden = !yt;
    $('#ytNotConfigured').hidden = !!yt;
    $('#ytProgressWrap').hidden = true;
    $('#ytStatus').textContent = 'The upload uses the title, description and hashtags from the Post tab.' + (isVertical() && r.duration <= 180 ? ' This clip will be tagged #Shorts.' : '');
    $('#btnYtUpload').disabled = false;
    showStep('stepDone');
    toast('Render complete!');
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function downloadResult() {
    if (!R.result) return;
    const a = document.createElement('a');
    a.href = R.result.url; a.download = R.result.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    R.downloaded = true;
  }
  $('#btnDownload').addEventListener('click', () => { downloadResult(); toast('Saved ' + R.result.name); });
  $('#btnNativeShare').addEventListener('click', () => {
    if (!R.result) return;
    const file = new File([R.result.blob], R.result.name, { type: R.result.type });
    navigator.share({ files: [file], title: S.title || 'Gameplay clip', text: captionText() }).catch((err) => {
      if (err && err.name !== 'AbortError') toast('Sharing failed: ' + err.message, true);
    });
  });
  function postTo(pl) {
    if (!R.result) return;
    const w = window.open(pl.url, '_blank', 'noopener');
    if (!R.downloaded) downloadResult();
    copyText(captionText(pl.id)).then(() => toast((w ? 'Opened ' + pl.name + '. ' : '') + 'Clip saved and caption copied. Attach the file and paste.'));
  }
  $('#btnYtUpload').addEventListener('click', function () {
    if (!R.result || !window.YTUpload) return;
    const btn = this;
    btn.disabled = true;
    const tags = parseTags();
    let title = (S.title || baseName()).trim();
    if (isVertical() && R.result.duration <= 180 && !/#shorts/i.test(title)) title = (title + ' #Shorts').slice(0, 100);
    const desc = [S.description.trim(), tags.map((t) => '#' + t).join(' ')].filter(Boolean).join('\n\n');
    $('#ytStatus').textContent = 'Signing in with Google…';
    $('#ytProgressWrap').hidden = false;
    $('#ytProgress').style.width = '0%';
    YTUpload.upload({
      blob: R.result.blob, title, description: desc, tags, privacy: $('#ytPrivacy').value,
      onProgress: (p) => { $('#ytProgress').style.width = (p * 100).toFixed(1) + '%'; $('#ytStatus').textContent = 'Uploading… ' + Math.round(p * 100) + '%'; }
    }).then((res) => {
      $('#ytProgress').style.width = '100%';
      $('#ytStatus').innerHTML = 'Uploaded! YouTube is processing it now: <a href="' + res.url + '" target="_blank" rel="noopener">' + res.url + '</a>';
      toast('Uploaded to YouTube 🎉');
    }).catch((err) => {
      $('#ytStatus').textContent = 'Upload failed: ' + err.message;
      toast('YouTube upload failed', true);
    }).finally(() => { btn.disabled = false; });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && R.exporting && R.exp) { try { document.title = '⏸ Keep ClipHeist visible…'; } catch (e) { /* ignore */ } }
    else document.title = 'Studio — ClipHeist';
  });
  window.addEventListener('beforeunload', (e) => { if (R.exporting || R.clips.length) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('resize', () => {
    clearTimeout(window.__chResize);
    window.__chResize = setTimeout(() => { if (R.ready) drawRuler(); if (!R.exporting) applyPreset(); }, 200);
  });

  // =====================================================================
  //  VOICE-OVER
  // =====================================================================
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function activeVos() { return R.vo.filter((v) => !v.muted && v.buffer); }
  function currentOutT() { const tm = previewTiming(); return tm ? tm.t : 0; }

  function distortionCurve(k) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
    return c;
  }
  /** Voice chain: polish (high-pass, presence, compressor, make-up) + optional character filter. */
  function buildVoiceChain(ac, dest) {
    const nodes = [];
    const input = ac.createGain();
    nodes.push(input);
    let last = input;
    const add = (n) => { last.connect(n); last = n; nodes.push(n); return n; };
    if (S.voPolish) {
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90; hp.Q.value = 0.7; add(hp);
      const pres = ac.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.gain.value = 3; pres.Q.value = 0.9; add(pres);
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -26; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.18;
      add(comp);
      const mu = ac.createGain(); mu.gain.value = 1.7; add(mu);
    }
    if (S.voFilter === 'radio' || S.voFilter === 'megaphone') {
      const radio = S.voFilter === 'radio';
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = radio ? 1700 : 1400; bp.Q.value = radio ? 0.8 : 1.6; add(bp);
      const ws = ac.createWaveShaper(); ws.curve = distortionCurve(radio ? 6 : 22); ws.oversample = '2x'; add(ws);
      const g2 = ac.createGain(); g2.gain.value = radio ? 1.6 : 1.3; add(g2);
    }
    last.connect(dest);
    return { input, dispose: () => nodes.forEach((n) => { try { n.disconnect(); } catch (e) { /* ignore */ } }) };
  }
  function rebuildLiveVoiceChain() {
    if (!A.ctx || !A.voBus) return;
    stopVo();
    if (A.voChain) A.voChain.dispose();
    A.voChain = buildVoiceChain(A.ctx, A.voBus);
    if (!video.paused && !R.exporting) rescheduleVo();
  }

  /** Speech regions of a take, in output-timeline seconds (drives ducking). */
  function voRegions(vo) {
    if (vo._regions && vo._regionsStart === vo.start) return vo._regions;
    const b = vo.buffer, sr = b.sampleRate, d = b.getChannelData(0), hop = Math.round(sr * 0.02);
    const env = [];
    for (let i = 0; i < d.length; i += hop) {
      let e = 0;
      const end = Math.min(d.length, i + hop);
      for (let j = i; j < end; j++) e += d[j] * d[j];
      env.push(Math.sqrt(e / Math.max(1, end - i)));
    }
    const se = env.slice().sort((x, y) => x - y);
    const thr = Math.max(0.012, (se[Math.floor(se.length * 0.2)] || 0) * 3);
    const regs = [];
    let cur = null;
    env.forEach((e, i) => {
      const t = i * 0.02;
      if (e > thr) {
        if (cur && t - cur[1] < 0.35) cur[1] = t + 0.02;
        else { cur = [t, t + 0.02]; regs.push(cur); }
      }
    });
    vo._regions = regs.filter((r) => r[1] - r[0] > 0.08).map((r) => [vo.start + r[0], vo.start + r[1]]);
    vo._regionsStart = vo.start;
    return vo._regions;
  }
  /** Duck automation; `base` is the context time that corresponds to output time 0. */
  function scheduleDuck(param, base, fromT) {
    if (S.voDuck <= 0) return;
    const lvl = Math.pow(10, -S.voDuck / 20);
    activeVos().forEach((vo) => voRegions(vo).forEach((r) => {
      if (r[1] + 0.3 < fromT) return;
      param.setTargetAtTime(lvl, base + Math.max(fromT, r[0] - 0.06), 0.04);
      param.setTargetAtTime(1, base + Math.max(fromT, r[1] + 0.12), 0.15);
    }));
  }

  function stopVo() {
    R.voNodes.forEach((n) => { try { n.src.stop(); } catch (e) { /* not started */ } try { n.src.disconnect(); n.g.disconnect(); } catch (e) { /* ignore */ } });
    R.voNodes = [];
    if (A.ctx && A.bed) { A.bed.gain.cancelScheduledValues(0); A.bed.gain.setValueAtTime(1, A.ctx.currentTime); }
  }
  function scheduleVoAt(outT) {
    stopVo();
    if (!A.ctx || !A.voChain) return;
    const now = A.ctx.currentTime + 0.02, base = now - outT;
    activeVos().forEach((vo) => {
      if (vo.start + vo.buffer.duration <= outT) return;
      const src = A.ctx.createBufferSource();
      src.buffer = vo.buffer;
      const g = A.ctx.createGain();
      g.gain.value = vo.gain;
      src.connect(g).connect(A.voChain.input);
      src.start(base + Math.max(vo.start, outT), Math.max(0, outT - vo.start));
      R.voNodes.push({ src, g });
    });
    if (A.bed) { A.bed.gain.cancelScheduledValues(0); A.bed.gain.setValueAtTime(1, now); scheduleDuck(A.bed.gain, base, outT); }
  }
  function rescheduleVo() {
    if (R.voRec || !R.vo.length || video.paused) { if (!R.vo.length) stopVo(); return; }
    const tm = previewTiming();
    if (!tm) { stopVo(); return; }
    ensureAudio().then(() => scheduleVoAt(tm.t));
  }
  function mixVoOffline(oac, master, bed, total) {
    const vos = activeVos();
    if (!vos.length) return;
    const chain = buildVoiceChain(oac, master);
    vos.forEach((vo) => {
      if (vo.start >= total) return;
      const src = oac.createBufferSource();
      src.buffer = vo.buffer;
      const g = oac.createGain();
      g.gain.value = vo.gain;
      src.connect(g).connect(chain.input);
      src.start(Math.max(0, vo.start), Math.max(0, -vo.start));
    });
    bed.gain.setValueAtTime(1, 0);
    scheduleDuck(bed.gain, 0, 0);
  }

  function drawSubs(W, H, tm) {
    if (!S.voSubs || !tm || !R.vo.length) return;
    let text = null;
    for (const vo of R.vo) {
      if (vo.muted || !vo.cues) continue;
      for (const c of vo.cues) {
        if (tm.t >= vo.start + c.a && tm.t <= vo.start + c.b + 0.25) { text = c.text; break; }
      }
      if (text) break;
    }
    if (!text) return;
    const vertical = H > W;
    const size = Math.round(Math.min(W, H) * 0.042);
    ctx.save();
    ctx.font = '800 ' + size + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrapLines(text, W * 0.8);
    const lh = size * 1.28;
    const y0 = H * (vertical ? 0.63 : 0.78) - (lines.length - 1) * lh / 2;
    lines.forEach((ln, i) => {
      const y = y0 + i * lh, tw = ctx.measureText(ln).width, pad = size * 0.35;
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(W / 2 - tw / 2 - pad, y - lh / 2, tw + pad * 2, lh, size * 0.2);
      else ctx.rect(W / 2 - tw / 2 - pad, y - lh / 2, tw + pad * 2, lh);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(ln, W / 2, y + size * 0.04);
    });
    ctx.restore();
  }

  // ---- sequence helpers ----
  function startSeqAt(outT) {
    const segs = reelSegs();
    const q = Object.assign(seqInfo(segs), { waiting: true });
    let i = 0;
    while (i < segs.length - 1 && outT >= q.offsets[i + 1]) i++;
    q.i = i;
    R.seq = q;
    R.snapReady = false;
    video.pause();
    video.currentTime = segs[i].start + Math.max(0, outT - q.offsets[i]) * S.speed;
    prepareStandby();
    return q;
  }
  function outTimeAtSource(srcT) {
    const segs = reelSegs(), info = seqInfo(segs);
    for (let i = 0; i < segs.length; i++) if (srcT >= segs[i].start && srcT < segs[i].end) return info.offsets[i] + (srcT - segs[i].start) / S.speed;
    return 0;
  }

  // ---- recording ----
  function toggleVoRecording() { if (R.voRec) stopVoRecording(); else startVoRecording(); }
  async function startVoRecording() {
    if (R.voRec || !R.ready || R.exporting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { toast('Recording isn\'t supported in this browser.', true); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: !!S.voNoise, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      toast('Microphone access was blocked. Allow the mic in your browser\'s site settings and try again.', true);
      return;
    }
    await ensureAudio();
    stopSeq(); video.pause(); stopVo();
    const startT = S.voFrom === 'playhead' ? outTimeAtSource(video.currentTime) : 0;
    const msrc = A.ctx.createMediaStreamSource(stream);
    const an = A.ctx.createAnalyser();
    an.fftSize = 1024;
    msrc.connect(an);
    const vr = { stream, an, msrc, startT, chunks: [], cues: [], active: true, rec: null, speech: null, t0: 0 };
    R.voRec = vr;
    $('#btnVoRecord').textContent = '■ Stop recording';
    $('#btnVoRecord').classList.add('recording');
    const ov = $('#recOverlay');
    ov.hidden = false;
    ov.classList.add('counting');
    for (let c = 3; c > 0; c--) {
      $('#recCount').textContent = c;
      await sleep(750);
      if (R.voRec !== vr) return;
    }
    ov.classList.remove('counting');
    startSeqAt(startT);
    await waitUntil(() => !R.seq || !R.seq.waiting || R.voRec !== vr);
    if (R.voRec !== vr) return;
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
    vr.rec = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) vr.chunks.push(e.data); };
    vr.stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(250);
    vr.t0 = performance.now();
    video.play().catch(() => {});
    if (SpeechRec && S.voAuto) startSpeech(vr);
  }
  function startSpeech(vr) {
    let recog;
    try { recog = new SpeechRec(); } catch (e) { return; }
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = navigator.language || 'en-US';
    let phraseStart = null;
    recog.onresult = (e) => {
      const now = currentOutT() - vr.startT;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (phraseStart == null) phraseStart = Math.max(0, now - 0.6);
        if (r.isFinal) {
          const text = (r[0] && r[0].transcript || '').trim();
          if (text) vr.cues.push.apply(vr.cues, splitCue(text, phraseStart, Math.max(now, phraseStart + 0.8)));
          phraseStart = null;
        }
      }
    };
    recog.onerror = () => {};
    recog.onend = () => { if (vr.active) { try { recog.start(); } catch (e) { /* ignore */ } } };
    try { recog.start(); vr.speech = recog; } catch (e) { /* ignore */ }
  }
  function splitCue(text, a, b) {
    const words = text.split(/\s+/), chunks = [];
    for (let i = 0; i < words.length; i += 6) chunks.push(words.slice(i, i + 6).join(' '));
    const d = (b - a) / chunks.length;
    return chunks.map((c, i) => ({ a: a + i * d, b: a + (i + 1) * d, text: c }));
  }
  async function stopVoRecording(cancel) {
    const vr = R.voRec;
    if (!vr) return;
    R.voRec = null;
    vr.active = false;
    if (vr.speech) { try { vr.speech.stop(); } catch (e) { /* ignore */ } }
    video.pause();
    stopSeq();
    if (vr.rec && vr.rec.state !== 'inactive') { vr.rec.stop(); await vr.stopped; }
    vr.stream.getTracks().forEach((t) => t.stop());
    try { vr.msrc.disconnect(); } catch (e) { /* ignore */ }
    $('#recOverlay').hidden = true;
    $('#btnVoRecord').textContent = '🎙 Record voice-over';
    $('#btnVoRecord').classList.remove('recording');
    if (cancel || !vr.chunks.length) { toast('Recording cancelled.'); return; }
    const blob = new Blob(vr.chunks, { type: (vr.rec && vr.rec.mimeType) || 'audio/webm' });
    let buffer;
    try {
      const ac = new OfflineAudioContext(1, 1, 48000);
      buffer = await ac.decodeAudioData(await blob.arrayBuffer());
    } catch (e) { toast('Couldn\'t read the recording: ' + e.message, true); return; }
    const take = { id: R.nextVoId++, name: 'Take ' + (R.vo.length + 1), start: Math.max(0, vr.startT + S.voOffset / 1000), buffer, blob, gain: 1, muted: false, cues: vr.cues };
    R.vo.push(take);
    renderVoList();
    R.dirty = true;
    toast('Voice-over saved: ' + take.name + ' (' + buffer.duration.toFixed(1) + 's' + (take.cues.length ? ', ' + take.cues.length + ' captions' : '') + ')');
  }
  async function addVoFromFile(file, at) {
    if (!file) return;
    try {
      const ac = new OfflineAudioContext(1, 1, 48000);
      const buffer = await ac.decodeAudioData(await file.arrayBuffer());
      const take = { id: R.nextVoId++, name: file.name.replace(/\.[^.]+$/, '').slice(0, 30), start: at != null ? at : (R.ready ? outTimeAtSource(video.currentTime) : 0), buffer, blob: file, gain: 1, muted: false, cues: [] };
      R.vo.push(take);
      renderVoList();
      toast('Voice-over added at ' + fmt(take.start));
    } catch (e) { toast('Couldn\'t read that audio file.', true); }
  }
  function updateRecUi() {
    const vr = R.voRec;
    if (!vr) return;
    const buf = new Float32Array(vr.an.fftSize);
    vr.an.getFloatTimeDomainData(buf);
    let e = 0;
    for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
    const lvl = clamp((20 * Math.log10(Math.sqrt(e / buf.length) + 1e-6) + 60) / 60, 0, 1);
    $('#recMeter').style.width = (lvl * 100).toFixed(0) + '%';
    $('#voMeter').style.width = (lvl * 100).toFixed(0) + '%';
    if (vr.t0) $('#recTime').textContent = fmt((performance.now() - vr.t0) / 1000, false) + ' · at ' + fmt(currentOutT(), false);
  }

  function renderVoList() {
    const ol = $('#voList');
    ol.innerHTML = '';
    R.vo.forEach((vo) => {
      const li = document.createElement('li');
      li.className = 'vo-item' + (vo.muted ? ' muted' : '');
      li.dataset.id = vo.id;
      li.innerHTML =
        '<div class="vo-head"><input class="vo-name" value="' + esc(vo.name) + '" maxlength="30" aria-label="Take name">' +
        '<button type="button" data-vo="play" title="Play from this take">▶</button>' +
        '<button type="button" data-vo="mute" title="Mute / unmute">' + (vo.muted ? '🔇' : '🔊') + '</button>' +
        '<button type="button" data-vo="del" title="Delete take">✕</button></div>' +
        '<div class="vo-row"><label>Starts at <input type="number" class="vo-start" min="0" step="0.05" value="' + vo.start.toFixed(2) + '">s</label>' +
        '<span class="vo-dur">' + vo.buffer.duration.toFixed(1) + 's</span></div>' +
        '<div class="vo-row"><label class="vo-vol">Vol <input type="range" class="vo-gain" min="0" max="2" step="0.05" value="' + vo.gain + '"></label></div>' +
        (vo.cues.length ? '<details class="vo-cues"><summary>' + vo.cues.length + ' captions</summary>' +
          vo.cues.map((c, i) => '<div class="vo-cue"><span>' + fmt(vo.start + c.a, false) + '</span><input data-cue="' + i + '" value="' + esc(c.text) + '"><button type="button" data-vo="delcue" data-cue="' + i + '">✕</button></div>').join('') +
          '</details>' : '');
      ol.appendChild(li);
    });
    $('#voCount').textContent = R.vo.length + (R.vo.length === 1 ? ' take' : ' takes');
  }
  function voById(el) { const li = el.closest('.vo-item'); return li ? R.vo.find((v) => String(v.id) === li.dataset.id) : null; }
  $('#voList').addEventListener('input', (e) => {
    const vo = voById(e.target);
    if (!vo) return;
    if (e.target.classList.contains('vo-name')) vo.name = e.target.value;
    else if (e.target.classList.contains('vo-gain')) { vo.gain = parseFloat(e.target.value); if (!video.paused) rescheduleVo(); }
    else if (e.target.dataset.cue != null && e.target.tagName === 'INPUT') { vo.cues[+e.target.dataset.cue].text = e.target.value; R.dirty = true; }
  });
  $('#voList').addEventListener('change', (e) => {
    const vo = voById(e.target);
    if (vo && e.target.classList.contains('vo-start')) { vo.start = Math.max(0, parseFloat(e.target.value) || 0); vo._regions = null; renderVoList(); R.dirty = true; }
  });
  $('#voList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-vo]');
    if (!b) return;
    const vo = voById(b);
    if (!vo) return;
    const act = b.dataset.vo;
    if (act === 'del') { if (!confirm('Delete ' + vo.name + '?')) return; R.vo.splice(R.vo.indexOf(vo), 1); stopVo(); }
    else if (act === 'mute') { vo.muted = !vo.muted; if (!video.paused) rescheduleVo(); }
    else if (act === 'delcue') { vo.cues.splice(+b.dataset.cue, 1); }
    else if (act === 'play') { startSeqAt(vo.start); ensureAudio().then(() => video.play().catch(() => {})); return; }
    renderVoList();
    R.dirty = true;
  });
  $('#btnVoRecord').addEventListener('click', toggleVoRecording);
  $('#btnRecStop').addEventListener('click', () => stopVoRecording(false));
  $('#btnRecCancel').addEventListener('click', () => stopVoRecording(true));
  $('#voImport').addEventListener('change', (e) => { addVoFromFile(e.target.files[0]); e.target.value = ''; });
  if (!SpeechRec) { const h = $('#voAutoHint'); if (h) h.textContent = 'Auto-captions need Chrome or Edge (speech recognition isn\'t available in this browser).'; }

  // =====================================================================
  //  AI EDIT
  // =====================================================================
  const AI_TARGETS = {
    short30: { label: 'Shorts / TikTok / Reels · 30s', preset: 'shorts', secs: 30 },
    short45: { label: 'Shorts / TikTok / Reels · 45s', preset: 'shorts', secs: 45 },
    short60: { label: 'Shorts / TikTok / Reels · 60s', preset: 'shorts', secs: 58 },
    yt60: { label: 'YouTube · 1 minute', preset: 'yt-1080', secs: 60 },
    yt120: { label: 'YouTube · 2 minutes', preset: 'yt-1080', secs: 120 },
    best: { label: 'Best moments only (any length)', preset: null, secs: 0 }
  };
  const AI_STYLES = {
    hype: { label: 'Hype', icon: '🔥', desc: 'Fast cuts, punch-ins, whips', trans: ['whip', 'zoom', 'glitch', 'white'], transDur: 0.4, fx: { Impact: 60, Shake: 25, Glow: 30 }, bars: false, look: 'vivid', anim: 'pop', fadeIn: 0.2, fadeOut: 0.6 },
    cinematic: { label: 'Cinematic', icon: '🎬', desc: 'Push-ins, grain, slow fades', trans: ['fade', 'black'], transDur: 0.8, fx: { Push: 40, Grain: 20 }, bars: true, look: 'golden', anim: 'slide', fadeIn: 0.6, fadeOut: 1.2 },
    funny: { label: 'Funny / Fails', icon: '💀', desc: 'Hard cuts, zoom punches', trans: ['zoom', 'cut', 'glitch'], transDur: 0.3, fx: { Impact: 80 }, bars: false, look: 'original', anim: 'pop', fadeIn: 0.1, fadeOut: 0.5 },
    chill: { label: 'Chill / Scenic', icon: '🌴', desc: 'Long takes, soft dissolves', trans: ['fade'], transDur: 0.9, fx: { Glow: 40, Push: 25 }, bars: false, look: 'ocean', anim: 'slide', fadeIn: 0.8, fadeOut: 1.5 }
  };

  function buildAiUi() {
    const sel = $('#aiTargetSel');
    sel.innerHTML = Object.keys(AI_TARGETS).map((k) => '<option value="' + k + '">' + AI_TARGETS[k].label + '</option>').join('');
    const grid = $('#aiStyleGrid');
    Object.keys(AI_STYLES).forEach((k) => {
      const st = AI_STYLES[k];
      const lab = document.createElement('label');
      lab.className = 'ai-style';
      lab.innerHTML = '<input type="radio" name="aiStyle" value="' + k + '" data-bind="aiStyle"><i>' + st.icon + '</i><b>' + st.label + '</b><small>' + st.desc + '</small>';
      grid.appendChild(lab);
    });
    $('#aiCloudRow').hidden = !CFG.aiEndpoint;
  }
  const aiModal = $('#aiModal');
  function openAi() {
    if (!R.ready) return;
    video.pause();
    stopSeq();
    aiModal.hidden = false;
    if (R.aiEditActive && R.clips.length) { openAiPreview(false); return; }
    showAiView('setup');
    $('#aiBeatHint').textContent = R.musicFile ? 'Your music track is loaded, so cuts will land on its beat.' : 'Add a music track on the Audio tab to sync cuts to the beat.';
    setAiButtons();
    if (R.ai && R.ai.token === R.loadToken) drawAiGraph();
    else { R.ai = null; setAiStatus('Step 1: analyze your footage. This runs on your device; nothing is uploaded.', 0); drawAiGraph(); }
  }
  function closeAi() {
    if (R.aiBusy) R.aiCancel = true;
    if (R.aipOn) { R.aipOn = false; video.pause(); stopSeq(); }
    aiModal.hidden = true;
    applyPreset();
    R.dirty = true;
  }
  $('#btnAiEdit').addEventListener('click', openAi);
  $('#aiClose').addEventListener('click', closeAi);
  aiModal.addEventListener('click', (e) => { if (e.target === aiModal && !R.aiBusy) closeAi(); });
  $('#btnAiAnalyze').addEventListener('click', () => { if (R.aiBusy) { R.aiCancel = true; return; } analyzeFootage(); });
  $('#btnAiCreate').addEventListener('click', () => createAiEdit().catch((e) => { console.error(e); setAiStatus('AI Edit failed: ' + e.message, null); R.aiBusy = false; setAiButtons(); }));
  $('#btnAiUndo').addEventListener('click', undoAiEdit);
  $('#btnAiPreview').addEventListener('click', () => openAiPreview(true));

  function setAiStatus(msg, frac) {
    $('#aiStatus').textContent = msg;
    const bar = $('#aiProgress');
    if (frac == null) bar.parentElement.hidden = true;
    else { bar.parentElement.hidden = false; bar.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%'; }
  }
  function setAiButtons() {
    $('#btnAiAnalyze').textContent = R.aiBusy ? 'Cancel' : (R.ai ? '↻ Re-analyze' : '🔍 Analyze footage');
    $('#btnAiCreate').disabled = R.aiBusy;
    $('#btnAiUndo').hidden = !R.aiUndo;
    $('#btnAiPreview').hidden = !(R.aiEditActive && R.clips.length);
  }

  async function scanByPlayback(onFrame, token) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = R.url;
    try { await once(v, 'loadeddata', 10000); } catch (e) { return; }
    v.playbackRate = 4;
    let next = 0;
    await new Promise((resolve) => {
      const cb = (now, meta) => {
        if (R.aiCancel || token !== R.loadToken) { resolve(); return; }
        const t = meta.mediaTime;
        if (t >= next) { onFrame(v, t); next = t + CHAI.STEP; }
        setAiStatus('Watching the footage… ' + Math.round(t / R.duration * 100) + '%', 0.3 + 0.7 * t / R.duration);
        if (v.ended || t >= R.duration - 0.05) { resolve(); return; }
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
      v.onended = resolve;
      v.play().catch(resolve);
    });
    v.pause();
    v.removeAttribute('src');
    v.load();
  }

  async function analyzeFootage() {
    if (!R.ready || R.aiBusy) return;
    if (R.demuxState === 'loading') { setAiStatus('Waiting for source indexing…', 0); await R.demuxPromise; }
    R.aiBusy = true;
    R.aiCancel = false;
    setAiButtons();
    const token = R.loadToken;
    const F = CHAI.createFeatures(R.duration);
    const cancelled = () => R.aiCancel || token !== R.loadToken;
    const t0 = performance.now();
    try {
      const win = 60;
      for (let t = 0; t < R.duration; t += win) {
        if (cancelled()) throw new Error('cancelled');
        setAiStatus('Listening for big moments… ' + Math.round(t / R.duration * 100) + '%', 0.3 * t / R.duration);
        let buf = null;
        try { buf = await sourceAudioRange(t, Math.min(R.duration, t + win)); } catch (e) { console.info('Audio analysis skipped:', e.message); break; }
        CHAI.addAudio(F, buf, t);
      }
      const TW = 32, TH = 18;
      const c = mk(TW, TH), cctx = c.getContext('2d', { willReadFrequently: true });
      const sampler = CHAI.makeFrameSampler(TW, TH);
      const onFrame = (src, t) => { cctx.drawImage(src, 0, 0, TW, TH); sampler(F, t, cctx.getImageData(0, 0, TW, TH).data); };
      if (R.exactOk) {
        await CHExact.scanVideo(R.file, R.demux, CHAI.STEP, onFrame,
          (p) => setAiStatus('Watching the footage… ' + Math.round(p * 100) + '%', 0.3 + 0.7 * p), cancelled);
      } else if (HAS_RVFC) {
        await scanByPlayback(onFrame, token);
      }
      if (cancelled()) throw new Error('cancelled');
      R.ai = { F, track: F.hasVideo ? CHAI.buildTrack(F) : null, token, seconds: (performance.now() - t0) / 1000 };
      const sig = [F.hasAudio ? 'audio' : null, F.hasVideo ? 'motion' : null].filter(Boolean).join(' + ') || 'no signals';
      setAiStatus('Analyzed ' + fmt(R.duration, false) + ' of footage (' + sig + ') in ' + R.ai.seconds.toFixed(1) + 's. Pick a target and style, then create your edit.', null);
      drawHeat();
      drawAiGraph();
    } catch (e) {
      if (e.message === 'cancelled') setAiStatus('Analysis cancelled.', null);
      else { console.error(e); setAiStatus('Analysis failed: ' + e.message, null); }
    } finally {
      R.aiBusy = false;
      setAiButtons();
    }
  }

  function heatColor(v) { // v in 0..1
    const stops = [[34, 216, 224], [139, 92, 246], [255, 61, 129], [255, 178, 43]];
    const f = clamp(v, 0, 1) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), r = f - i;
    const c = stops[i].map((x, k) => Math.round(x + (stops[i + 1][k] - x) * r));
    return 'rgb(' + c.join(',') + ')';
  }
  function normScore(sc) {
    const arr = Array.from(sc.score), sorted = arr.slice().sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.995)] || 1;
    return arr.map((x) => clamp((x - lo) / Math.max(1e-6, hi - lo), 0, 1));
  }
  function drawHeat() {
    const cv = $('#heat');
    if (!R.ai) { cv.hidden = true; return; }
    cv.hidden = false;
    const w = cv.width = Math.max(200, timeline.clientWidth), h = cv.height = 10;
    const g = cv.getContext('2d');
    const v = normScore(CHAI.score(R.ai.F, S.aiStyle));
    g.clearRect(0, 0, w, h);
    for (let x = 0; x < w; x++) {
      const i = Math.floor(x / w * v.length);
      g.fillStyle = heatColor(v[i]);
      g.globalAlpha = 0.35 + 0.65 * v[i];
      g.fillRect(x, h - Math.max(2, v[i] * h), 1, Math.max(2, v[i] * h));
    }
  }
  function drawAiGraph(picks) {
    const cv = $('#aiGraph');
    const w = cv.width = cv.clientWidth * (window.devicePixelRatio || 1) || 600, h = cv.height = 130 * (window.devicePixelRatio || 1);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0f0d17';
    g.fillRect(0, 0, w, h);
    if (!R.ai) {
      g.fillStyle = '#6f698c';
      g.font = (13 * (window.devicePixelRatio || 1)) + 'px ' + FONT;
      g.textAlign = 'center';
      g.fillText('Excitement curve appears here after analysis', w / 2, h / 2);
      return;
    }
    const sc = CHAI.score(R.ai.F, S.aiStyle), v = normScore(sc), dur = R.duration;
    (picks || []).forEach((p) => {
      g.fillStyle = 'rgba(255,61,129,0.18)';
      g.fillRect(p.start / dur * w, 0, (p.end - p.start) / dur * w, h);
      g.fillStyle = '#ff3d81';
      g.fillRect(p.peak / dur * w - 1, 0, 2, h);
    });
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    sc.cuts.forEach((c) => { g.beginPath(); g.moveTo(c / dur * w, h - 6); g.lineTo(c / dur * w, h); g.stroke(); });
    const grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, '#22d8e0'); grad.addColorStop(0.5, '#ff3d81'); grad.addColorStop(1, '#ffb22b');
    g.beginPath();
    g.moveTo(0, h);
    v.forEach((y, i) => g.lineTo(i / v.length * w, h - 6 - y * (h - 16)));
    g.lineTo(w, h);
    g.closePath();
    g.globalAlpha = 0.28; g.fillStyle = grad; g.fill();
    g.globalAlpha = 1; g.strokeStyle = grad; g.lineWidth = 1.5 * (window.devicePixelRatio || 1);
    g.beginPath();
    v.forEach((y, i) => { const x = i / v.length * w, yy = h - 6 - y * (h - 16); if (i) g.lineTo(x, yy); else g.moveTo(x, yy); });
    g.stroke();
  }

  async function grabFrames(times, width) {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = R.url;
    await once(v, 'loadeddata', 10000);
    const c = mk(width, Math.round(width * (v.videoHeight || 9) / (v.videoWidth || 16)));
    const g = c.getContext('2d');
    const out = [];
    for (const t of times) {
      v.currentTime = clamp(t, 0, R.duration - 0.05);
      try { await once(v, 'seeked', 6000); } catch (e) { continue; }
      g.drawImage(v, 0, 0, c.width, c.height);
      out.push(c.toDataURL('image/jpeg', 0.72).split(',')[1]);
    }
    v.removeAttribute('src'); v.load();
    return out;
  }

  async function aiWriteup(picks, style) {
    const vertical = isVertical();
    const local = Object.assign(CHAI.localWriteup(style, vertical, picks, R.file ? R.file.name : 'clip'), { source: 'on-device' });
    if (!S.aiCloud || !CFG.aiEndpoint || R.aiCloudOff) return local;
    try {
      setAiStatus('Writing your title and captions with AI…', 0.9);
      const images = await grabFrames(picks.slice(0, 6).map((p) => p.peak), 384);
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(CFG.aiEndpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({
          style, target: S.aiTarget, vertical, notes: (S.aiNotes || '').slice(0, 500),
          clips: picks.map((p) => ({ start: +p.start.toFixed(2), end: +p.end.toFixed(2), reasons: p.reasons })), images
        })
      });
      clearTimeout(to);
      if (res.status === 501 || res.status === 404 || res.status === 405) { R.aiCloudOff = true; throw new Error('cloud writer not configured on this site'); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      return {
        title: (j.title || local.title).slice(0, 100), description: j.description || local.description,
        hashtags: Array.isArray(j.hashtags) && j.hashtags.length ? j.hashtags : local.hashtags,
        hook: typeof j.hook_caption === 'string' ? j.hook_caption : local.hook,
        clipCaptions: Array.isArray(j.clip_captions) ? j.clip_captions : [], source: 'AI'
      };
    } catch (e) {
      console.info('Cloud writer unavailable, using on-device copy:', e.message);
      return local;
    }
  }

  async function createAiEdit() {
    if (!R.ready) return;
    if (!R.ai || R.ai.token !== R.loadToken) { await analyzeFootage(); if (!R.ai) return; }
    R.aiBusy = true;
    setAiButtons();
    const style = S.aiStyle in AI_STYLES ? S.aiStyle : 'hype';
    const st = AI_STYLES[style], tgt = AI_TARGETS[S.aiTarget] || AI_TARGETS.short30;
    const snapshot = { clips: R.clips.map((c) => Object.assign({}, c)), S: JSON.parse(JSON.stringify(S)) };
    setAiStatus('Finding the best moments…', 0.8);
    const sc = CHAI.score(R.ai.F, style);
    let picks = CHAI.pick(R.ai.F, sc, { style, target: tgt.secs, speed: S.speed, order: S.aiOrder });
    if (!picks.length) { R.aiBusy = false; setAiButtons(); setAiStatus('No strong moments found. Try another style or a longer target.', null); return; }

    // beat sync
    let beat = null;
    if (S.aiBeat && R.musicFile) {
      try { beat = CHAI.detectBeats(await musicBuffer()); } catch (e) { beat = null; }
      if (beat) {
        const per = style === 'cinematic' || style === 'chill' ? 4 : 2, P = beat.period;
        picks.forEach((p) => {
          const outD = (p.end - p.start) / S.speed;
          const nb = Math.max(per, Math.round(outD / P / per) * per);
          const len = Math.min(R.duration, nb * P * S.speed);
          const s0 = clamp(p.peak - 0.62 * len, 0, Math.max(0, R.duration - len));
          p.start = s0; p.end = s0 + len;
        });
        if (tgt.secs) {
          let total = picks.reduce((a, p) => a + (p.end - p.start) / S.speed, 0);
          while (picks.length > 1 && total > tgt.secs + P * 0.5) {
            const worst = picks.reduce((m, p, i) => (p.score < picks[m].score ? i : m), 0);
            total -= (picks[worst].end - picks[worst].start) / S.speed;
            picks.splice(worst, 1);
          }
        }
        // quantizing can push neighbours into each other: shift later clips, keep whole beats
        picks = CHAI.resolveOverlaps(picks, R.duration, P * S.speed * 0.99);
        picks.forEach((p) => {
          const n = Math.max(1, Math.floor((p.end - p.start) / (P * S.speed) + 1e-6));
          p.end = p.start + n * P * S.speed;
        });
        S.musicStart = +beat.first.toFixed(3);
      }
    }

    picks = CHAI.resolveOverlaps(picks, R.duration, 0.5);
    // format + look
    if (tgt.preset) S.preset = tgt.preset;
    const vertical = PRESETS[S.preset].h > PRESETS[S.preset].w;
    if (S.aiReframe && vertical && R.ai.track) { S.frame = 'fill'; S.autoReframe = true; S.zoom = 100; }
    if (S.aiFx) {
      Object.assign(S, LOOKS[st.look].v);
      S.look = st.look;
      EFFECTS.forEach((ef) => { S['fx' + ef.id] = false; });
      Object.keys(st.fx).forEach((id) => { S['fx' + id] = true; S['fx' + id + 'Amt'] = st.fx[id]; });
      S.bars = st.bars;
      S.transition = st.trans[0];
      S.transDur = st.transDur;
      S.fadeIn = st.fadeIn; S.fadeOut = st.fadeOut;
      S.captionAnim = st.anim;
    }
    R.clips = picks.map((p, i) => ({
      id: R.nextClipId++, start: p.start, end: p.end, caption: '', ai: p,
      trans: i === 0 ? 'default' : (S.aiFx ? st.trans[(i - 1) % st.trans.length] : 'default')
    }));

    let source = '';
    if (S.aiCaptions) {
      const w = await aiWriteup(picks, style);
      source = w.source;
      S.title = w.title;
      S.description = w.description;
      S.tags = w.hashtags.map((t) => '#' + String(t).replace(/^#+/, '').replace(/\s+/g, '')).join(' ');
      S.caption = w.hook || '';
      S.captionTiming = 'first';
      R.clips.forEach((c, i) => { c.caption = (w.clipCaptions[i] || '').slice(0, 60); });
      if (S.caption && R.clips[0]) R.clips[0].caption = '';
    }
    R.aiUndo = snapshot;
    applyPreset();
    renderClips();
    R.inPt = R.clips[0].start; R.outPt = R.clips[0].end;
    updateMarks();
    syncControls();
    saveSettings();
    R.dirty = true;
    R.aiBusy = false;
    setAiButtons();
    drawAiGraph(picks);
    const total = picks.reduce((a, p) => a + (p.end - p.start) / S.speed, 0);
    setAiStatus('✨ Built a ' + fmt(total, false) + ' ' + st.label.toLowerCase() + ' edit from ' + picks.length + ' moments' +
      (beat ? ', cut to ' + Math.round(beat.bpm) + ' BPM' : '') + (S.autoReframe && vertical ? ', with auto-reframe for vertical' : '') +
      (source ? '. Title and captions written ' + (source === 'AI' ? 'by AI' : 'on-device') : '') + '.', null);
    R.aiEditActive = true;
    R.aiInfo = { style: st.label, bpm: beat ? Math.round(beat.bpm) : 0, source };
    setAiButtons();
    openAiPreview(true);
  }
  function undoAiEdit() {
    const u = R.aiUndo;
    if (!u) return;
    R.clips = u.clips;
    const keepAi = {};
    Object.keys(S).filter((k) => k.indexOf('ai') === 0).forEach((k) => { keepAi[k] = S[k]; });
    Object.assign(S, u.S, keepAi);
    R.aiUndo = null;
    applyPreset();
    renderClips();
    updateMarks();
    syncControls();
    saveSettings();
    R.dirty = true;
    R.aiEditActive = false;
    setAiButtons();
    showAiView('setup');
    drawAiGraph();
    setAiStatus('AI edit undone. Your previous reel and settings are back.', null);
  }


  // ---------- AI Edit: preview step ----------
  const aipCanvas = $('#aipCanvas');
  const aipCtx = aipCanvas.getContext('2d');
  const AIP_FORMATS = [['shorts', '9:16'], ['yt-1080', '16:9'], ['square', '1:1'], ['feed45', '4:5']];
  Object.assign(R, { aipOn: false, aipT: 0, aipScrubbing: false, aipWasPlaying: false, aiEditActive: false, aiInfo: null });

  function showAiView(which) {
    $('#aiSetupView').hidden = which !== 'setup';
    $('#aiPreviewView').hidden = which !== 'preview';
    const card = aiModal.querySelector('.modal-card');
    if (card) card.scrollTop = 0;
    const on = which === 'preview' && !aiModal.hidden;
    if (R.aipOn && !on) { video.pause(); stopSeq(); }
    R.aipOn = on;
    if (which === 'setup') drawAiGraph();
  }
  function aipTotal() { return reelDuration(); }
  function aipOffsets() { return seqInfo(reelSegs()).offsets; }
  function sizeAipCanvas() {
    const p = PRESETS[S.preset];
    const sc = Math.min(1, 720 / Math.max(p.w, p.h));
    aipCanvas.width = Math.round(p.w * sc);
    aipCanvas.height = Math.round(p.h * sc);
    aipCanvas.style.aspectRatio = p.w + ' / ' + p.h;
    $$('#aipFormats button').forEach((b) => b.classList.toggle('on', b.dataset.preset === S.preset));
  }
  function buildAipFormats() {
    $('#aipFormats').innerHTML = AIP_FORMATS.map((f) => '<button type="button" data-preset="' + f[0] + '" title="' + PRESETS[f[0]].name + ' · ' + PRESETS[f[0]].size + '">' + f[1] + '</button>').join('');
  }
  function openAiPreview(autoplay) {
    if (!R.clips.length) { showAiView('setup'); return; }
    showAiView('preview');
    sizeAipCanvas();
    applyPreset();
    renderAipTimeline();
    renderAipMoments();
    updateAipMeta();
    syncControls();
    R.aipT = 0;
    aipSeek(0, autoplay);
  }
  function updateAipMeta() {
    const p = PRESETS[S.preset], r = outRate(), n = R.clips.length, info = R.aiInfo || {};
    $('#aipTitle').textContent = S.title || 'Your AI edit';
    $('#aipMeta').textContent = fmt(aipTotal(), false) + ' · ' + n + (n === 1 ? ' moment' : ' moments') +
      (info.style ? ' · ' + info.style : '') + (info.bpm ? ' · cut to ' + info.bpm + ' BPM' : '') +
      (S.autoReframe && p.h > p.w ? ' · auto-reframed' : '') + (activeVos().length ? ' · voice-over' : '');
    $('#aipCount').textContent = n;
    $('#aipExportSpec').textContent = 'Exports ' + p.name + ' ' + p.w + '×' + p.h + ' at ' + fpsLabel(r) + ' fps' +
      ((engineWanted() && R.exactOk) ? ', frame-exact MP4' : ', real-time capture');
  }
  function renderAipTimeline() {
    const total = aipTotal(), offs = aipOffsets(), segs = reelSegs();
    $('#aipScrub').max = Math.max(0.01, total).toFixed(2);
    $('#aipSegs').innerHTML = segs.map((sg, i) => {
      const d = (sg.end - sg.start) / S.speed;
      return '<span data-i="' + i + '" title="Clip ' + (i + 1) + (i ? ' · ' + TRANS_LABEL[sg.trans] : '') + '" style="left:' + (offs[i] / total * 100) + '%;width:' + (d / total * 100) + '%;background:' + CLIP_COLORS[i % CLIP_COLORS.length] + '"></span>';
    }).join('');
  }
  function renderAipMoments() {
    const ol = $('#aipMoments');
    ol.innerHTML = R.clips.map((c, i) => {
      const reasons = c.ai ? c.ai.reasons.join(' · ') : 'Manual clip';
      return '<li class="aip-moment" data-id="' + c.id + '">' +
        '<span class="clip-n" data-m="go" style="background:' + CLIP_COLORS[i % CLIP_COLORS.length] + '">' + (i + 1) + '</span>' +
        '<div class="m-main" data-m="go"><b>' + fmt(c.start, false) + '–' + fmt(c.end, false) + ' · ' + ((c.end - c.start) / S.speed).toFixed(1) + 's</b><small>✨ ' + esc(reasons) + '</small></div>' +
        '<button type="button" class="m-del" data-m="del" title="Remove this moment" aria-label="Remove this moment">✕</button>' +
        '<div class="m-edit"><input class="m-cap" type="text" maxlength="60" placeholder="Caption for this clip (optional)" value="' + esc(c.caption || '') + '">' +
        (i > 0 ? '<select class="m-trans" title="Transition into this clip">' + transOptions(c.trans || 'default') + '</select>' : '<select disabled><option>Opening clip</option></select>') +
        '</div></li>';
    }).join('');
  }
  function aipSeek(t, play) {
    const total = aipTotal();
    t = clamp(t, 0, Math.max(0, total - 0.02));
    R.aipT = t;
    startSeqAt(t);
    if (play) {
      waitUntil(() => !R.seq || !R.seq.waiting).then(() => ensureAudio().then(() => { if (R.aipOn) video.play().catch(() => {}); }));
    }
  }
  function aipTogglePlay() {
    if (!R.aipOn) return;
    if (R.awaitStandby) { R.resumeAfterStandby = !R.resumeAfterStandby; return; }
    if (!video.paused) { video.pause(); return; }
    const total = aipTotal();
    if (!R.seq || R.aipT >= total - 0.05) aipSeek(R.aipT >= total - 0.05 ? 0 : R.aipT, true);
    else ensureAudio().then(() => video.play().catch(() => {}));
  }
  function aipJumpClip(dir) {
    const offs = aipOffsets(), t = R.aipT;
    let i = 0;
    while (i < offs.length - 1 && t >= offs[i + 1] - 0.01) i++;
    const target = dir < 0 ? (t - offs[i] > 0.6 ? offs[i] : offs[Math.max(0, i - 1)]) : offs[Math.min(offs.length - 1, i + 1)];
    aipSeek(target, !video.paused);
  }
  function drawAip() {
    const w = aipCanvas.width, h = aipCanvas.height;
    aipCtx.imageSmoothingQuality = 'high';
    aipCtx.drawImage(canvas, 0, 0, w, h);
    const total = aipTotal();
    if (R.seq) R.aipT = currentOutT();
    else if (!video.paused) R.aipT = total;
    const playing = !video.paused && !!R.seq;
    if (!R.aipScrubbing) $('#aipScrub').value = R.aipT.toFixed(2);
    $('#aipTime').innerHTML = fmt(R.aipT) + ' <span>/ ' + fmt(total) + '</span>';
    $('#aipPlay').textContent = playing ? '❚❚' : (R.aipT >= total - 0.05 ? '↻' : '▶');
    $('#aipBigPlay').hidden = playing || R.aipScrubbing;
    $('#aipBigPlay').textContent = R.aipT >= total - 0.05 ? '↻' : '▶';
    const offs = aipOffsets();
    let cur = 0;
    while (cur < offs.length - 1 && R.aipT >= offs[cur + 1]) cur++;
    $$('#aipMoments .aip-moment').forEach((li, i) => li.classList.toggle('playing', i === cur));
  }
  function aipAfterReelChange() {
    renderClips();
    renderAipTimeline();
    renderAipMoments();
    updateAipMeta();
    R.dirty = true;
  }

  $('#aipPlay').addEventListener('click', aipTogglePlay);
  $('#aipBigPlay').addEventListener('click', aipTogglePlay);
  $('#aipStage').addEventListener('click', (e) => { if (e.target === aipCanvas) aipTogglePlay(); });
  $('#aipRestart').addEventListener('click', () => aipSeek(0, true));
  $('#aipPrev').addEventListener('click', () => aipJumpClip(-1));
  $('#aipNext').addEventListener('click', () => aipJumpClip(1));
  const scrub = $('#aipScrub');
  scrub.addEventListener('pointerdown', () => { R.aipScrubbing = true; R.aipWasPlaying = !video.paused; video.pause(); });
  scrub.addEventListener('input', () => { R.aipScrubbing = true; aipSeek(parseFloat(scrub.value), false); });
  scrub.addEventListener('change', () => {
    R.aipScrubbing = false;
    aipSeek(parseFloat(scrub.value), R.aipWasPlaying);
    R.aipWasPlaying = false;
  });
  $('#aipSegs').addEventListener('click', (e) => {
    const sp = e.target.closest('span[data-i]');
    if (sp) aipSeek(aipOffsets()[+sp.dataset.i], !video.paused);
  });
  $('#aipFormats').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-preset]');
    if (!b || b.dataset.preset === S.preset) return;
    S.preset = b.dataset.preset;
    const p = PRESETS[S.preset];
    if (p.h > p.w && R.ai && R.ai.track && S.aiReframe) { S.frame = 'fill'; S.autoReframe = true; }
    sizeAipCanvas();
    applyPreset();
    syncControls();
    saveSettings();
    updateAipMeta();
    R.dirty = true;
    if (video.paused) { R.mediaTime = video.currentTime; renderFromVideo(); }
    toast('Switched to ' + p.name + ' (' + p.size + ')');
  });
  const momentsEl = $('#aipMoments');
  const momentClip = (el) => { const li = el.closest('.aip-moment'); return li ? R.clips.find((c) => String(c.id) === li.dataset.id) : null; };
  momentsEl.addEventListener('click', (e) => {
    const a = e.target.closest('[data-m]');
    if (!a) return;
    const c = momentClip(a);
    if (!c) return;
    const idx = R.clips.indexOf(c);
    if (a.dataset.m === 'go') { aipSeek(aipOffsets()[idx], true); return; }
    if (a.dataset.m === 'del') {
      if (R.clips.length <= 1) { toast('An edit needs at least one moment. Use Undo to remove the AI edit instead.', true); return; }
      video.pause();
      R.clips.splice(idx, 1);
      aipAfterReelChange();
      aipSeek(aipOffsets()[Math.min(idx, R.clips.length - 1)], false);
      toast('Moment removed. The edit is now ' + fmt(aipTotal(), false) + '.');
    }
  });
  momentsEl.addEventListener('input', (e) => {
    if (!e.target.classList.contains('m-cap')) return;
    const c = momentClip(e.target);
    if (c) { c.caption = e.target.value; R.dirty = true; renderClips(); }
  });
  momentsEl.addEventListener('change', (e) => {
    if (!e.target.classList.contains('m-trans')) return;
    const c = momentClip(e.target);
    if (c) { c.trans = e.target.value; aipAfterReelChange(); aipSeek(Math.max(0, aipOffsets()[R.clips.indexOf(c)] - 1.0), true); }
  });
  $('#aipBack').addEventListener('click', () => { showAiView('setup'); setAiButtons(); });
  $('#aipUndo').addEventListener('click', undoAiEdit);
  $('#aipStudio').addEventListener('click', () => { closeAi(); toast('Your AI edit is in the reel. Fine-tune it, then hit Export.'); });
  async function exportFromAi(autoStart) {
    closeAi();
    await openExport();
    if (autoStart && !$('#btnStartRender').disabled) $('#btnStartRender').click();
  }
  $('#aipExport').addEventListener('click', () => exportFromAi(true));
  $('#aipExportSettings').addEventListener('click', (e) => { e.preventDefault(); exportFromAi(false); });
  window.addEventListener('resize', () => { if (R.aipOn) sizeAipCanvas(); });


  /** Play ~1 s before a cut through the end of its transition, then pause — instant feedback. */
  function previewTransition(i) {
    if (!R.ready || R.exporting || R.voRec || R.clips.length < 2 || R.aipOn) return;
    const offs = seqInfo(reelSegs()).offsets;
    i = clamp(i || 1, 1, offs.length - 1);
    const q = startSeqAt(Math.max(0, offs[i] - 1.0));
    q.stopAt = offs[i] + S.transDur + 0.6;
    waitUntil(() => !R.seq || !R.seq.waiting).then(() => ensureAudio().then(() => { if (R.seq === q) video.play().catch(() => {}); }));
  }

  // ---------- init ----------
  buildPresetGrid();
  buildLookChips();
  buildFx();
  buildAiUi();
  buildAipFormats();
  buildFpsOptions();
  bindControls();
  applyPreset();
  syncControls();
  setEnabled(false);
  requestAnimationFrame(rafLoop);

  // small debug / automation surface
  window.ClipHeist = { state: S, runtime: R, loadFile, compose, presets: PRESETS, outRate, startVoRecording, stopVoRecording, analyzeFootage, createAiEdit, undoAiEdit, addVoFromFile, openAiPreview };
})();
