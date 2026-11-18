# Publishing ClipHeist on GitHub (and deploying it)

This guide takes you from the project folder to a public GitHub repository with automatic tests, a live site, and versioned releases. Budget about 20 minutes.

---

## 1. Create the repository

1. Sign in at **github.com** and click **+ → New repository**.
2. Repository name: `clipheist` (or anything you like).
3. Choose **Public**.
4. **Leave every "Initialize this repository" box unchecked**, so no README, .gitignore or license is added. The project already has them.
5. Click **Create repository** and keep the page open; it shows your repo URL.

## 2. Upload the code

> ⚠️ The project contains hidden folders, `.github/` (the automation) and dot files like `.gitignore`. Drag-and-drop upload in the browser often skips them, so use one of the two options below.

### Option A: GitHub Desktop (no command line)
1. Install **GitHub Desktop** from desktop.github.com and sign in.
2. **File → Add local repository →** choose the unzipped `clipheist` folder. When it asks, click **create a repository** here, then **Create repository**.
3. Click **Publish repository**. Pick your account and untick "Keep this code private" if you want it public.

### Option B: command line
```bash
cd path/to/clipheist
git init -b main
git add .
git commit -m "ClipHeist v1.0.0"
git remote add origin https://github.com/YOUR-USERNAME/clipheist.git
git push -u origin main
```

### Then
In `README.md`, replace `OWNER/REPO` (in the badges and clone URL) with `YOUR-USERNAME/clipheist`, then commit and push.

## 3. Watch the tests run

Open the **Actions** tab. The **CI** workflow runs on every push and takes 5–8 minutes:
- **Static checks + unit tests:** syntax, element ids, file references, the demuxer, the MP4 muxer, AI analysis, and the `/api/ai` function.
- **Browser tests:** real Chromium runs the Studio. It covers frame-exact exports (59.94 fps, B-frames, fps conversion, slow-mo), effects and transitions, seamless preview, AI Edit with preview and export, and voice-over.

A green check means it's ready to ship. If something fails, the run uploads screenshots under **Artifacts**.

## 4. Turn on GitHub Pages (free hosting)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Go to **Actions → Deploy to GitHub Pages → Run workflow**, or simply push again. It deploys automatically after CI passes.
3. Your site is live at `https://YOUR-USERNAME.github.io/clipheist/`, with the Studio at `…/clipheist/editor.html`.

On Pages, AI Edit writes titles and captions on-device. The Claude-powered writer needs a server function, so it's only available on Vercel (next step).

## 5. Deploy on Vercel (recommended, with auto-deploys and the AI writer)

1. At **vercel.com → Add New → Project**, **Import** your GitHub repo.
2. Set **Framework Preset: Other**. Leave Build Command and Output Directory empty.
3. Click **Deploy**. Every push to `main` now redeploys automatically, and pull requests get preview URLs.
4. *(Optional AI writer)* In **Project → Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY`: your key from console.anthropic.com
   - `ALLOWED_ORIGIN`: your site URL, e.g. `https://clipheist.vercel.app`, so other sites can't use your key
   - `ANTHROPIC_MODEL` *(optional)*: defaults to `claude-sonnet-5-5`

   Then **Deployments → ⋯ → Redeploy**.
5. If you previously deployed ClipHeist by uploading files, either delete that old project or point your domain at the new Git-connected one.

> 💡 Each AI Edit run with the writer enabled makes one API call, billed to your Anthropic account. Before promoting the site widely, add rate limiting, for example Vercel KV or Upstash, in `api/ai.js`.

## 6. Publish a release

Releases give people a versioned zip they can host anywhere.

```bash
git tag v1.0.0
git push origin v1.0.0
```

The **Release** workflow re-runs the checks, builds `clipheist-v1.0.0.zip`, and publishes a GitHub Release using the notes from `CHANGELOG.md`.

To ship later versions:
1. Add a `## [1.1.0] - YYYY-MM-DD` section to `CHANGELOG.md`.
2. Bump `version` in `package.json` and `assets/js/config.js`.
3. Bump `CACHE` in `sw.js`.
4. Commit, then tag `v1.1.0` and push the tag.

## 7. Polish the repo page (optional, 2 minutes)

- **About** (gear icon on the repo home): add a description, your site URL, and topics such as `video-editor`, `webcodecs`, `gaming`, `pwa` and `content-creation`.
- **Settings → Branches → Add rule** for `main`: require the **CI** checks to pass before merging.
- **Settings → General → Social preview:** upload a screenshot of the Studio. Use your own UI, not game art.

## Optional: direct YouTube upload

Add your OAuth client ID to `assets/js/config.js` (see the README). In Google Cloud Console, add **every** origin you serve from to "Authorized JavaScript origins", for example `https://YOUR-USERNAME.github.io` and `https://clipheist.vercel.app`.

## Troubleshooting

| Problem | Fix |
|---|---|
| 404 after deploying | `index.html` must be at the top level of the repo, not inside a subfolder |
| Pages workflow says "Pages not enabled" | Do step 4.1 (Source: GitHub Actions), then re-run |
| Old version still showing | The offline cache: bump `CACHE` in `sw.js`, then hard-refresh (Ctrl/Cmd+Shift+R) |
| Voice-over or clipboard doesn't work | These need HTTPS. Pages and Vercel provide it; for local testing use `http://localhost` |
| AI writer shows "on-device" on Vercel | Check that `ANTHROPIC_API_KEY` is set and that you redeployed afterwards |
