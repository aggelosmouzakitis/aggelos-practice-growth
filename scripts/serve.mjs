#!/usr/bin/env node
// Serves dist/ locally with the response headers Netlify would send: the
// [[headers]] blocks of netlify.toml plus dist/_headers (written for
// non-production builds), so the CSP and caching can be checked before a deploy.
//   node scripts/serve.mjs [port]      (default 8080)

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

// The subset of TOML this repo's netlify.toml uses for [[headers]].
function tomlHeaderRules(text) {
  const rules = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[[')) {
      cur = line === '[[headers]]' ? { for: null, values: {} } : null;
      if (cur) rules.push(cur);
      continue;
    }
    if (!cur || !line || line.startsWith('#') || line.startsWith('[')) continue;
    const m = line.match(/^("?)([^"=]+)\1\s*=\s*"((?:[^"\\]|\\.)*)"$/);
    if (!m) continue;
    if (m[2].trim() === 'for') cur.for = m[3];
    else cur.values[m[2].trim()] = m[3];
  }
  return rules;
}
function headersFileRules(text) {
  const rules = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = { for: raw.trim(), values: {} };
      rules.push(cur);
    } else if (cur) {
      const i = raw.indexOf(':');
      cur.values[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
    }
  }
  return rules;
}
function matches(pattern, urlPath) {
  if (pattern.endsWith('/*')) return urlPath.startsWith(pattern.slice(0, -1));
  return pattern === urlPath;
}

export function startServer(port = 8080) {
  const rules = tomlHeaderRules(fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8'));
  const extra = path.join(DIST, '_headers');
  if (fs.existsSync(extra)) rules.push(...headersFileRules(fs.readFileSync(extra, 'utf8')));

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(DIST, urlPath);
    if (!file.startsWith(DIST)) { res.writeHead(400); res.end(); return; }
    if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
    let status = 200;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || path.basename(file) === '_headers') {
      status = 404;
      file = path.join(DIST, '404.html');
    }
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
    for (const rule of rules) if (rule.for && matches(rule.for, urlPath)) Object.assign(headers, rule.values);
    res.writeHead(status, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]) || 8080;
  startServer(port).then(() => console.log(`serving dist/ at http://127.0.0.1:${port}/`));
}
