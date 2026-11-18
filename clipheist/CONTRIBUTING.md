# Contributing to ClipHeist

Thanks for helping! ClipHeist is a plain static site, with no bundler and no framework. Edit a file, refresh the browser.

## Run it locally
```bash
npm start            # serves the site at http://localhost:8080 (uses Python's http.server)
```
Open `http://localhost:8080/editor.html`. Use Chrome or Edge for the frame-exact export engine.

## Tests
```bash
npm test             # static release checks + unit tests (Node 20+, no install needed)

# browser end-to-end tests (Python 3.10+)
pip install -r tests/e2e/requirements.txt
python -m playwright install chromium
npm run test:e2e
```
The test videos in `tests/fixtures/` are synthetic. Regenerate them with `tests/fixtures/make_fixtures.sh` (needs ffmpeg).

## Project layout
| Path | What it is |
|---|---|
| `index.html` | Landing page |
| `editor.html`, `assets/js/editor.js` | The Studio: UI, compositor (effects, transitions, text), preview, export, voice-over, AI Edit UI |
| `assets/js/media/demux.js` | MP4/MOV/fragmented MP4 + WebM/MKV demuxer |
| `assets/js/media/exact.js` | Frame-exact render engine (WebCodecs) |
| `assets/js/media/mp4mux.js` | MP4 muxer (H.264 + AAC/Opus) |
| `assets/js/ai/analyze.js` | AI Edit analysis, highlight picking, beat detection |
| `api/ai.js` | Optional Vercel function for AI-written titles and captions |
| `sw.js` | Offline cache. **Bump `CACHE` whenever shipped files change.** |

## Ground rules
- **No game assets.** Don't add game footage, logos, key art, fonts or music from any publisher, including in tests or screenshots.
- Keep it dependency-free in the browser.
- Add or update a test with every behavior change. CI must be green before merging.
- Note user-facing changes in `CHANGELOG.md` under an "Unreleased" heading.
