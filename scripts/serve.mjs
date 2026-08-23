// Minimal static dev server that mirrors the vercel.json config
// (clean URLs, no trailing slash) so local behaviour matches production.
//
//   node scripts/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function resolve(pathname) {
  // Block path traversal before touching the filesystem.
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const candidates = safe.endsWith('/')
    ? [join(safe, 'index.html')]
    : [safe, `${safe}.html`, join(safe, 'index.html')];

  for (const rel of candidates) {
    const abs = join(ROOT, rel);
    if (!abs.startsWith(ROOT)) continue;
    try {
      const s = await stat(abs);
      if (s.isFile()) return abs;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const file = await resolve(pathname);

  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    console.log(`404 ${pathname}`);
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(await readFile(file));
  console.log(`200 ${pathname}`);
}).listen(PORT, () => {
  console.log(`SIM timetable dev server → http://localhost:${PORT}`);
});
