/*
 * ClipHeist AI writer: Vercel Serverless Function (POST /api/ai)
 *
 * Looks at a handful of small frames from the user's picked highlights and writes a title,
 * description, hashtags, a hook caption and short per-clip captions using Claude.
 *
 * Setup (Vercel → Project → Settings → Environment Variables):
 *   ANTHROPIC_API_KEY   required: your Anthropic API key (never exposed to the browser)
 *   ANTHROPIC_MODEL     optional: defaults to "claude-sonnet-5-5"
 *   ALLOWED_ORIGIN      optional: e.g. "https://your-site.vercel.app" to reject other origins
 *
 * Without ANTHROPIC_API_KEY this returns 501 and the Studio falls back to its on-device writer.
 */
'use strict';

const MAX_IMAGES = 6;
const MAX_IMAGE_B64 = 400 * 1024; // ~300 KB per JPEG
const MAX_CLIPS = 24;

const SYSTEM = [
  'You write short, punchy social-media copy for gameplay highlight edits.',
  'You are shown frames from the user\'s own gameplay recordings plus detected moment types.',
  'Respond with ONLY a JSON object, no prose, using exactly these keys:',
  '{"title": string <= 90 chars, "description": string <= 300 chars, "hashtags": string[] (5-10, lowercase, no "#", no spaces),',
  ' "hook_caption": string <= 40 chars (on-screen text for the first seconds, or "" for calm styles),',
  ' "clip_captions": string[] (one per clip, each <= 32 chars or "", sparing: at most every other clip)}',
  'Rules: match the requested style; be specific to what is visible; no hate, slurs, sexual content or real-person attacks;',
  'never imply the video is official or endorsed by a game publisher; do not invent game titles; you may mention a game name only if the user notes include it.',
  'If a hook_caption is given, clip_captions[0] must be "".'
].join(' ');

function bad(res, code, msg) { res.status(code).json({ error: msg }); }

function sanitize(out, nClips) {
  const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
  const tags = Array.isArray(out.hashtags) ? out.hashtags.map((t) => str(t, 40).replace(/^#+/, '').replace(/\s+/g, '').toLowerCase()).filter(Boolean).slice(0, 12) : [];
  let caps = Array.isArray(out.clip_captions) ? out.clip_captions.map((c) => str(c, 40)) : [];
  caps = caps.slice(0, nClips);
  while (caps.length < nClips) caps.push('');
  return {
    title: str(out.title, 100),
    description: str(out.description, 500),
    hashtags: tags,
    hook_caption: str(out.hook_caption, 48),
    clip_captions: caps
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Allow', 'POST'); return res.status(204).end(); }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return bad(res, 405, 'Method not allowed'); }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return bad(res, 501, 'AI writer is not configured on this deployment');
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.origin && req.headers.origin !== allowed) return bad(res, 403, 'Origin not allowed');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return bad(res, 400, 'Invalid JSON'); } }
  if (!body || typeof body !== 'object') return bad(res, 400, 'Missing body');

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (images.some((b) => typeof b !== 'string' || b.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(b))) return bad(res, 400, 'Invalid image data');
  const clips = Array.isArray(body.clips) ? body.clips.slice(0, MAX_CLIPS) : [];
  const style = ['hype', 'cinematic', 'funny', 'chill'].includes(body.style) ? body.style : 'hype';
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 500) : '';
  const vertical = !!body.vertical;

  const brief = {
    style,
    format: vertical ? 'vertical short (YouTube Shorts / TikTok / Reels)' : 'horizontal YouTube video',
    clip_count: clips.length,
    clips: clips.map((c, i) => ({ n: i + 1, seconds: Math.max(0, (+c.end || 0) - (+c.start || 0)).toFixed(1), detected: Array.isArray(c.reasons) ? c.reasons.slice(0, 4).map(String) : [] })),
    user_notes: notes
  };
  const content = images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }));
  content.push({ type: 'text', text: 'Frames above are the peak of each picked moment, in order.\nBrief: ' + JSON.stringify(brief) + '\nReturn the JSON now.' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: 700,
        system: SYSTEM,
        messages: [{ role: 'user', content }]
      })
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('Anthropic API error', r.status, detail.slice(0, 300));
      return bad(res, 502, 'AI service error (' + r.status + ')');
    }
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return bad(res, 502, 'AI returned no JSON');
    let parsed;
    try { parsed = JSON.parse(text.slice(a, b + 1)); } catch (e) { return bad(res, 502, 'AI returned invalid JSON'); }
    const out = sanitize(parsed, clips.length);
    if (out.hook_caption && out.clip_captions.length) out.clip_captions[0] = '';
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return bad(res, 500, 'AI request failed');
  }
};

module.exports.sanitize = sanitize;
