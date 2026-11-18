# Security policy

## Reporting a vulnerability
Please **don't open a public issue**. Report it privately with GitHub's **Security → Report a vulnerability** (Security Advisories) on this repository. We'll acknowledge it within a few days.

## Scope notes
- All video processing happens in the user's browser. Footage is never uploaded by the Studio.
- The optional `api/ai.js` function keeps `ANTHROPIC_API_KEY` server-side and never returns it. If you deploy it publicly:
  - Set `ALLOWED_ORIGIN` to your site's URL.
  - Add rate limiting, for example Vercel KV or Upstash, so others can't spend your API credits.
  - Rotate the key immediately if it's ever exposed.
- Never commit `.env` files. Use your host's environment-variable settings.
