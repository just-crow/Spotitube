import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validId } from './catalog.mjs';

/** Loopback-only, unguessable URLs give Chromium standard HTTP range/seek behavior. */
export async function createMediaServer(catalog, downloads, fetcher) {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const match = new RegExp(`^/${token}/([\\w-]{11})(?:\\?.*)?$`).exec(req.url || '');
    if (!match || !validId(match[1]) || !['GET', 'HEAD'].includes(req.method) || (req.headers.origin && !['spotitube://app', 'null'].includes(req.headers.origin))) { res.writeHead(403).end(); return; }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const headers = { 'access-control-allow-origin': req.headers.origin === 'null' ? 'null' : 'spotitube://app', 'access-control-expose-headers': 'Content-Length, Content-Range', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=300' };
    try {
      const file = downloads.local(match[1]);
      if (file) {
        const size = fs.statSync(file).size; let start = 0, end = size - 1;
        const range = req.headers.range;
        if (range) {
          const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!parsed) { res.writeHead(416, headers).end(); return; }
          if (!parsed[1]) start = Math.max(0, size - Number(parsed[2]));
          else { start = Number(parsed[1]); if (parsed[2]) end = Math.min(end, Number(parsed[2])); }
          if (start > end || start >= size) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end(); return; }
        }
        res.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': downloads.mime(match[1]), 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
        if (req.method === 'HEAD') res.end(); else await pipeline(fs.createReadStream(file, { start, end }), res, { signal: controller.signal });
      } else {
        const stream = await catalog.resolve(match[1]);
        const response = await fetcher(stream.url, { headers: { ...stream.headers, ...(req.headers.range ? { Range: req.headers.range } : {}) }, signal: controller.signal });
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (response.headers.has(key)) headers[key] = response.headers.get(key);
        res.writeHead(response.status, headers);
        if (req.method === 'HEAD' || !response.body) res.end(); else await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal });
      }
    } catch { if (!res.headersSent) res.writeHead(502, headers); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: id => `http://127.0.0.1:${server.address().port}/${token}/${id}`, close: () => { server.closeAllConnections(); server.close(); } };
}
