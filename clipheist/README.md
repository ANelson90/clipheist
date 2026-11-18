# ClipHeist: gameplay clip studio

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![Deploy to GitHub Pages](https://github.com/OWNER/REPO/actions/workflows/pages.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-ff3d81.svg)](LICENSE)

ClipHeist is a free, open-source clip studio that runs entirely in the browser. Players trim, reframe and caption open-world gameplay, built with GTA VI players in mind, then post to YouTube, Shorts, TikTok, Instagram, X and more.
**Footage never leaves the user's device** unless they choose to post it.

- ✨ **AI Edit:** finds your best moments, builds a styled edit, cuts it to the beat, follows the action in 9:16, and writes the title. Preview it, tweak it, and export in one click.
- 🎞 **Effects and 11 transitions:** looks, shake, impact zoom, glow, RGB split, grain, VHS, plus whip, zoom, glitch and iris transitions.
- 🎙 **Voice-over:** record commentary over your edit, with voice polish, filters, automatic ducking and live auto-captions.
- 🎯 **Frame-exact export:** decodes every frame with WebCodecs and writes a constant-frame-rate MP4 that matches your footage (59.94 stays 59.94).
- 📱 **Platform presets and sharing:** Shorts/TikTok/Reels, YouTube up to 4K, 4:5, 1:1. Direct YouTube upload is optional.

> Unofficial fan-made tool. Not affiliated with Rockstar Games or Take-Two Interactive. It contains no game assets.

## Quick start

There's no build step, and the browser side has no dependencies.

```bash
git clone https://github.com/OWNER/REPO.git
cd REPO
npm start                 # or: python3 -m http.server 8080
# open http://localhost:8080
```

Use the latest **Chrome or Edge** for frame-exact exports. Other browsers fall back to real-time capture.

## Deploy

| Where | What you get | How |
|---|---|---|
| **GitHub Pages** | The full Studio (AI Edit writes captions on-device) | Settings → Pages → Source: **GitHub Actions**. `.github/workflows/pages.yml` publishes after CI passes |
| **Vercel** (recommended) | Everything, plus the Claude-powered AI writer (`api/ai.js`) | Import the repo with Framework Preset **Other**, then set `ANTHROPIC_API_KEY` (see `.env.example`) |
| **GitHub Releases** | A ready-to-upload zip for any static host | `git tag v1.0.0 && git push origin v1.0.0` |

**The full step-by-step guide is in [docs/DEPLOY.md](docs/DEPLOY.md).**

## Tests

```bash
npm test                  # static release checks + 19 unit tests (Node 20+)
pip install -r tests/e2e/requirements.txt && python -m playwright install chromium
npm run test:e2e          # 15 browser tests: exports, effects, preview, AI Edit, voice-over
```

CI runs all of these on every push and pull request (`.github/workflows/ci.yml`).

## Project layout

```
├── index.html              Landing page
├── editor.html             The Studio
├── manifest.webmanifest    PWA manifest
├── sw.js                   Offline cache (bump CACHE when shipped files change)
├── vercel.json             Vercel headers/config
├── api/ai.js               Optional Vercel function: Claude writes titles/captions for AI Edit
├── assets/
│   ├── css/styles.css
│   ├── img/                Original logo + illustration (no game assets)
│   └── js/
│       ├── config.js       Site settings: version, YouTube client ID, AI endpoint, hashtags
│       ├── editor.js       Studio UI, compositor (effects + transitions), preview, export, voice-over, AI Edit UI
│       ├── youtube.js      Optional direct YouTube upload
│       ├── media/demux.js  MP4/MOV/fragmented MP4 + WebM/MKV demuxer
│       ├── media/exact.js  Frame-exact render engine (WebCodecs)
│       ├── media/mp4mux.js MP4 muxer (H.264 + AAC/Opus)
│       └── ai/analyze.js   AI Edit analysis, highlight picking, beat detection
├── tests/                  unit/ (node:test), e2e/ (pytest + Playwright), fixtures/ (synthetic videos)
├── scripts/check.mjs       Release checks: syntax, element ids, file references
├── docs/DEPLOY.md          GitHub + Pages + Vercel + release guide
└── .github/                CI, Pages deploy, release workflows, issue/PR templates
```

## Studio features

| Area | What it does |
|---|---|
| **Clip marks** | "Last 15/30/60s" replay-style marks, draggable In/Out handles, frame stepping, a thumbnail filmstrip |
| **Reel** | Stack several ranges into one montage, reorder them, add a dip-to-black between clips |
| **Format presets** | YouTube 1080p, 1440p and 4K; Shorts, TikTok and Reels at 1080×1920; vertical 720p; Instagram 4:5; square 1:1; X and Discord at 720p |
| **Framing** | Crop to fill (zoom and pan to follow the action) or fit with a blurred backdrop |
| **Looks** | Vivid, Golden Hour, Neon Night, Ocean Drive, Bleach and Noir presets, plus brightness, contrast, saturation, tint, vignette and letterbox bars |
| **Effects** | Camera shake, impact zoom (punch-in at each clip start), slow push-in, glow/bloom, RGB split, animated film grain, VHS (scanlines, chroma bleed, tracking band), mirror, black-and-white ending. Each has an intensity control, and there are presets: Action, Cinematic, Retro VHS, Dreamy, Chaos |
| **Transitions** | Cut, crossfade, dip to black, flash, slide, push, wipe, zoom punch, whip pan, glitch, iris. Set a global default, override it per clip, adjust duration from 0.15 to 1.5 s, add an optional synthesized whoosh, and preview the whole reel with **Play reel** (`R`) |
| **Text** | Captions in outline, box or glow style with pop, slide or typewriter entrances and timing options, a creator-handle watermark, and safe-zone guides for each platform's buttons |
| **Audio** | Game volume and mute, an added music track with its own volume and start offset, fades |
| **Speed** | 0.25× to 2× (slow motion included) |
| **Frame rate** | Detects the source frame rate (23.976 to 240, including VFR). Output can match the source or be set to 23.976, 24, 25, 29.97, 30, 50, 59.94 or 60 fps. Sources above 60 fps export at 60 |
| **Export** | Frame-exact MP4 (H.264 + AAC, or Opus where AAC encoding isn't available) at 6 to 45 Mbps. The real-time fallback records MP4 or WebM |
| **Share** | Download, the native share sheet (mobile), one-tap "save, copy caption, open upload page" for 8 platforms, and direct YouTube upload |
| **Thumbnails** | One-click PNG snapshot of the current frame (`P`) |
| **Voice-over** | Record from the mic while the edit plays (`V`), with a 3-2-1 countdown and level meter. Takes sit on the output timeline and can be nudged, set in volume, muted or deleted. Also: imported audio files, voice polish (high-pass, presence EQ, compressor), radio and megaphone filters, automatic ducking of game and music (0–24 dB), live auto-captions via the browser's speech recognition (editable, burned in as subtitles) and latency compensation |
| **AI Edit** | Analyzes the whole recording on-device, then builds an edit for a target (Shorts 30/45/60 s, YouTube 1/2 min, or best moments only) in a style (Hype, Cinematic, Funny/Fails, Chill/Scenic). Options: open with the biggest moment, beat-synced cuts to your music, auto-reframe that follows the action in 9:16, the style's look/effects/transitions, and auto title, hashtags and captions. Fully undoable. A heat map of the analysis shows on the timeline |
| **AI Edit preview & export** | After creating an edit, a preview player shows it with all transitions, effects, captions, music and voice-over. Controls: play/pause (`Space`), restart, previous/next clip (`←`/`→`), and a scrubber with colored clip segments. Switch 9:16 / 16:9 / 1:1 / 4:5 instantly. Moments can be removed, re-captioned or given a different transition, and the title, opening caption and hashtags are editable. **Export this edit** starts a frame-exact render right away, and *Export settings…* opens the export dialog first |

Keyboard: `Space` play/pause · `I`/`O` set In/Out · `A` add to reel · `R` play reel with transitions · `←`/`→` step a frame · `Shift+←/→` jump 1s · `J`/`L` jump 5s · `P` snapshot.

### How frame rate is preserved

**Preview.** The preview is driven by `requestVideoFrameCallback`, so it draws exactly once per decoded source frame at the source's own cadence. It renders at the size it's actually shown on screen, and resolution drops automatically under load so frames are never skipped. Two decoders alternate across reel clips: while one plays, the other is already seeked to the next clip's first frame, so cuts and transitions play without a stall. A small meter shows the live preview fps, the preview resolution, and any dropped frames.

**Frame-exact export (default in Chrome and Edge).**
1. `media/demux.js` indexes every video and audio sample in the file: timestamps, keyframes and byte offsets. It supports MP4, MOV, fragmented MP4, WebM and MKV, and handles B-frames and edit lists.
2. `media/exact.js` decodes every frame with WebCodecs `VideoDecoder`, starting from the keyframe before each clip.
3. Output frames sit on an exact grid (`k × 1001/60000` s for 59.94 fps). Each output frame uses the source frame on screen at that moment, sampled at frame centers so millisecond-rounded container timestamps can't cause jitter. When the output matches the source rate, that's exactly one output frame per source frame.
4. The compositor adds effects, transitions and text, then `VideoEncoder` (H.264) encodes the frame and `media/mp4mux.js` writes a constant-frame-rate MP4 (`stts` uses a single delta).
5. Audio: each clip's source audio is decoded with `AudioDecoder`, then music, transition whooshes and fades are mixed **offline at 48 kHz** in an `OfflineAudioContext`, sample-aligned to the video timeline, and encoded with `AudioEncoder`.

Because nothing depends on real-time playback, a busy computer can't drop or duplicate frames, and you can switch tabs while it renders. With a GPU, renders usually run faster than real time.

**Real-time engine (fallback).** In browsers without WebCodecs, or for codecs WebCodecs can't decode, the canvas is captured with `captureStream()` and encoded with `MediaRecorder` while the clip plays. Keep the tab visible while it renders.

**Verified in testing:** a 59.94 fps VP9 source exported to exactly 270 frames at 60000/1001, each one advancing exactly one source frame. A 29.97 fps H.264 source with B-frames exported with one-to-one frame mapping. 59.94 → 30 fps conversion thinned evenly to every second frame. 0.5× slow motion at 59.94 held each source frame for exactly 4 output frames. Audio duration matched video within codec padding (about 20 ms).

### Browser support
| Browser | Editing | Export format |
|---|---|---|
| Chrome / Edge 116+ (desktop) | ✅ | **Frame-exact** MP4 (H.264 + AAC) ✅ |
| Firefox 130+ | ✅ | Frame-exact MP4 where H.264 encoding is available, otherwise real-time WebM |
| Safari 17+ | ✅ (no canvas color filters) | Varies by version: frame-exact where WebCodecs is complete, otherwise real-time |
| Mobile Chrome | ✅ (smaller files work best) | Frame-exact MP4 |

TikTok and Instagram require **MP4**. When a browser can only export WebM, the export dialog shows a warning.

## How AI Edit works

All analysis runs in the browser, so footage is never uploaded.
1. **Audio:** the source audio is decoded with WebCodecs (or `decodeAudioData` as a fallback), and loudness and transient "impact" energy are measured every 0.1 s.
2. **Video:** every frame is decoded once with WebCodecs. A 32×18 thumbnail every 0.1 s gives motion (frame difference), flashes, saturation, scene cuts, and the horizontal center of motion. Browsers without WebCodecs use 4× playback sampling instead.
3. **Scoring:** signals are normalized robustly and weighted per style. Hype weights impacts and motion, Cinematic weights color and steady motion, and so on. The result is smoothed, and build-ups get a bonus.
4. **Picking:** the highest peaks grow into clips of a style-appropriate length, snap to nearby scene cuts, never overlap, and stop before weak filler. With music loaded, the music's tempo is detected and every clip becomes a whole number of beats, so cuts land on the beat.
5. **Auto-reframe:** a heavily smoothed, speed-limited track of where the action is drives the 9:16 crop frame by frame, in both preview and export.
6. **Writing:** titles, hashtags and a hook caption come from on-device templates. **Optional cloud writer:** deploy to Vercel and set `ANTHROPIC_API_KEY` in Project → Settings → Environment Variables. `api/ai.js` then sends about 6 small JPEG frames plus the detected moment types to Claude and returns a title, description, hashtags, a hook caption and per-clip captions. Optional variables: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) and `ALLOWED_ORIGIN` (to reject requests from other sites). Without the key, the function returns 501 and the Studio quietly uses on-device copy. Each AI Edit costs one API call, billed to your Anthropic account, so consider adding rate limiting (for example Vercel KV or Upstash) before a big launch.

## Voice-over notes
- Recording needs HTTPS (or localhost) and microphone permission.
- Auto-captions use the browser's Web Speech API (Chrome and Edge). Chrome sends that audio to its speech service. Turn it off in Voice settings if you'd rather it didn't.
- The frame-exact engine mixes takes sample-accurately at 48 kHz, applying the voice chain and ducking automation offline. The real-time engine schedules them live.

## Turn on direct YouTube upload (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and **enable the YouTube Data API v3**.
2. Set up the **OAuth consent screen** and add the scope `https://www.googleapis.com/auth/youtube.upload`.
3. Create an **OAuth 2.0 Client ID** of type **Web application**. Under **Authorized JavaScript origins**, add your site's origin (for example `https://clipheist.example` or `http://localhost:8080`).
4. Paste the client ID into `assets/js/config.js`:
   ```js
   youtubeClientId: '1234567890-abc.apps.googleusercontent.com',
   ```
5. After a render, users click **Sign in & upload**. The video uploads with the title, description, hashtags and privacy setting from the Post tab, in the Gaming category. Vertical clips of 3 minutes or less get `#Shorts`.

> **Note:** Google locks videos uploaded through *unverified* API projects to **private** until the project passes YouTube's API compliance audit. Each upload also costs API quota (about 1,600 units of the default 10,000 per day). Before launching publicly, apply for verification and a quota increase.

TikTok and Instagram don't let websites post for users without app approval (TikTok Content Posting API, Instagram Graph API). ClipHeist uses the share sheet or "save, copy, open" flow instead. You can add those APIs later in `editor.js` → `postTo()`.

## Copyright and trademark notes

- **No game assets are included.** The logo, illustration, colors and UI are original. The illustration is a generic sunset city, not taken from any game.
- The product name "ClipHeist" is generic. Game titles appear only in descriptive, compatibility statements ("built for GTA VI players"), and the footer has a non-affiliation disclaimer. Keep it that way: don't add official logos, key art, fonts, screenshots or music from any game.
- Platform names appear as plain text, not logos. If you add platform logos, follow each company's brand guidelines.
- The Studio steers users away from Content ID claims. It explains the risk of in-game radio, offers a game-audio mute and a royalty-free music slot, and includes a pre-post checklist.
- Before launch, consider having a lawyer review your final branding and domain name, especially if you add "GTA" or other trademarks to them, which is **not recommended**.

## Customize

- **Brand colors:** CSS variables at the top of `assets/css/styles.css` (`--pink`, `--orange`, `--teal`, `--sunset`).
- **Presets, looks, platforms:** the `PRESETS`, `LOOKS` and `PLATFORMS` objects at the top of `assets/js/editor.js`.
- **Hashtag suggestions:** `suggestedHashtags` in `assets/js/config.js`.
- **Effects / transitions:** `EFFECTS`, `FX_PRESETS` and `TRANSITIONS` in `editor.js`. Transitions live in `applyTransition()`, effects in `compose()`.
- After changing files, bump `CACHE` in `sw.js` (for example to `clipheist-v3`) so returning visitors get the update.

## License
The code is MIT-licensed (see `LICENSE`). Users are responsible for the content they upload.
