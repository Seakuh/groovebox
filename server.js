// Groovebox-Server: liefert die App aus und reicht den Live-Zustand per SSE an Zuschauer im WLAN weiter.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8787;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const clients = new Set();
let last = null;
let svgs = '[]';

// Echte WLAN/LAN-Adapter zuerst, Docker-/VM-Bridges raus
const lanUrls = () => {
  const all = Object.entries(networkInterfaces())
    .flatMap(([name, list]) => (list || []).map(a => ({ name, ...a })))
    .filter(a => a.family === 'IPv4' && !a.internal);
  const real = all.filter(a => /^(wl|en|eth)/.test(a.name));
  return (real.length ? real : all).map(a => `http://${a.address}:${PORT}/?view`);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/info') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ urls: lanUrls() }));
  }

  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    res.write(`event: svg\ndata: ${svgs}\n\n`);
    if (last) res.write(`data: ${last}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Nur die Groovebox auf diesem Rechner darf den Zustand senden
  if (url.pathname === '/state' && req.method === 'POST') {
    if (!LOCAL.has(req.socket.remoteAddress)) { res.writeHead(403); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 100_000) req.destroy(); });
    req.on('end', () => {
      last = body.replace(/\n/g, '');
      for (const c of clients) c.write(`data: ${last}\n\n`);
      res.writeHead(204); res.end();
    });
    return;
  }

  if (url.pathname === '/svg' && req.method === 'POST') {
    if (!LOCAL.has(req.socket.remoteAddress)) { res.writeHead(403); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8_000_000) req.destroy(); });
    req.on('end', () => {
      try { svgs = JSON.stringify(JSON.parse(body)); } catch { res.writeHead(400); return res.end(); }
      for (const c of clients) c.write(`event: svg\ndata: ${svgs}\n\n`);
      res.writeHead(204); res.end();
    });
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT) || rel.split('/').some(p => p.startsWith('.'))) { res.writeHead(404); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Nicht gefunden');
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Groovebox:  http://localhost:${PORT}`);
  lanUrls().forEach(u => console.log(`Zuschauer:  ${u}`));
});
