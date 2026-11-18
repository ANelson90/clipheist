# Changelog

All notable changes to ClipHeist are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-18

First public release.

### Added
- **Studio:**
  - Trimming with replay-style "last 15/30/60 s" marks, In/Out handles and a filmstrip timeline.
  - Multi-clip reels with per-clip captions.
  - Platform presets: YouTube 1080p/1440p/4K, Shorts/TikTok/Reels 9:16, 4:5, 1:1, and X/Discord.
- **Looks and effects:**
  - 7 one-click looks, plus brightness, contrast, saturation, tint, vignette and letterbox bars.
  - 9 effects: shake, impact zoom, push-in, glow, RGB split, grain, VHS, mirror and a black-and-white ending.
  - 6 effect presets.
- **Transitions:** 11 transitions with per-clip overrides, adjustable duration and an optional synthesized whoosh.
- **Frame-exact export:**
  - Every source frame is decoded with WebCodecs, composited on an exact output frame grid, encoded to H.264 and written as a constant-frame-rate MP4.
  - Audio is mixed sample-accurately at 48 kHz.
  - Matches 23.976 to 60 fps sources (including 59.94) and converts variable-frame-rate recordings to a constant rate.
  - A real-time MediaRecorder engine is the compatibility fallback.
- **Voice-over:**
  - Recording synced to the edit, imported takes, voice polish, radio and megaphone filters, and automatic ducking.
  - Live auto-captions burned in as subtitles.
- **AI Edit:**
  - On-device highlight detection (audio, impacts, motion, flashes, scene cuts) and four edit styles.
  - Beat-synced cuts, follow-the-action auto-reframe for 9:16, and auto titles, hashtags and captions.
  - Optional Claude-powered writer through `api/ai.js`.
  - Preview screen with editable moments, instant format switching and one-click export.
- **Sharing:** download, native share sheet, a quick-post flow for 8 platforms, and optional direct YouTube upload.
- **Offline-capable PWA.**
- **Tests:** 19 unit tests, 15 browser end-to-end tests, and static release checks, all running in CI.

### Performance
- The preview renders at display resolution and adapts under load. With seven effects on, compositing dropped from 145 ms to 19 ms per frame on the test machine.
- Two decoders alternate across reel clips, so clip boundaries play without a seek stall. On long-keyframe 1080p60 footage the stall went from about 2 s to under 15 ms per cut when the standby decoder is ready.
- Changing a transition plays the affected cut automatically.
