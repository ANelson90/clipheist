#!/usr/bin/env node
/**
 * Static release checks (no dependencies):
 *  1. every JS file parses (node --check)
 *  2. JSON files are valid
 *  3. every #id the Studio script looks up exists in editor.html
 *  4. every local <script src>, <link href>, <img src> and service-worker cache entry exists
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p);
let failures = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

console.log('JavaScript syntax');
const jsFiles = [...walk(path.join(ROOT, 'assets/js'), '.js'), ...walk(path.join(ROOT, 'api'), '.js'), path.join(ROOT, 'sw.js'), ...walk(path.join(ROOT, 'scripts'), '.mjs')];
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) fail(rel(f) + '\n' + r.stderr); else ok(rel(f));
}

console.log('JSON');
for (const f of ['manifest.webmanifest', 'vercel.json', 'package.json']) {
  try { JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); ok(f); } catch (e) { fail(f + ': ' + e.message); }
}

console.log('Studio element ids');
const editorHtml = fs.readFileSync(path.join(ROOT, 'editor.html'), 'utf8');
const ids = new Set([...editorHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const editorJs = fs.readFileSync(path.join(ROOT, 'assets/js/editor.js'), 'utf8');
const used = new Set([...editorJs.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g), ...editorJs.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !ids.has(id));
if (missing.length) fail('ids used in editor.js but missing from editor.html: ' + missing.join(', '));
else ok(used.size + ' ids referenced, all present');
const dupes = [...editorHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length) fail('duplicate ids in editor.html: ' + dupes.join(', ')); else ok('no duplicate ids');

console.log('Local file references');
for (const page of ['index.html', 'editor.html']) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+?)"/g)].map((m) => m[1]).filter((r) => !r.startsWith('//') && !r.startsWith('mailto'));
  const bad = refs.filter((r) => !fs.existsSync(path.join(ROOT, r)));
  if (bad.length) fail(page + ' references missing files: ' + bad.join(', ')); else ok(page + ': ' + refs.length + ' references');
}
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const shell = [...sw.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((x) => /\.(html|js|css|svg|webmanifest)$/.test(x));
const badShell = shell.filter((x) => !fs.existsSync(path.join(ROOT, x)));
if (badShell.length) fail('sw.js caches missing files: ' + badShell.join(', ')); else ok('sw.js: ' + shell.length + ' cached files exist');
const allScripts = walk(path.join(ROOT, 'assets/js'), '.js').map((f) => rel(f).split(path.sep).join('/'));
const uncached = allScripts.filter((f) => !shell.includes(f));
if (uncached.length) fail('scripts not in the offline cache (sw.js): ' + uncached.join(', ')); else ok('all scripts are cached for offline use');

console.log(failures ? `\n${failures} problem(s) found` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
