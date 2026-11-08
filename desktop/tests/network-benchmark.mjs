import { app, net } from 'electron';
import { Catalog } from '../catalog.mjs';
const catalog = new Catalog('desktop/tools');
app.whenReady().then(async () => {
try {
  for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['dQw4w9WgXcQ']) {
    const start = performance.now(); const stream = await catalog.resolve(id);
    console.log(JSON.stringify({ id, stage: 'resolve', ms: Math.round(performance.now() - start), format: stream.format, client: new URL(stream.url).searchParams.get('c') }));
    for (const mode of ['header32k', 'header256k']) {
      const size = mode.includes('256') ? 262144 : 32768;
      const t = performance.now(); let first = 0, bytes = 0;
      try {
        const url = new URL(stream.url); const headers = { ...stream.headers };
        if (mode.startsWith('query')) url.searchParams.set('range', `0-${size - 1}`); else headers.Range = `bytes=0-${size - 1}`;
        const r = await net.fetch(url.href, { headers, signal: AbortSignal.timeout(10000) });
        for await (const chunk of r.body) { if (!first) first = Math.round(performance.now() - t); bytes += chunk.length; }
        console.log(JSON.stringify({ id, mode, status: r.status, bytes, firstMs: first, totalMs: Math.round(performance.now() - t) }));
      } catch (e) { console.log(JSON.stringify({ id, mode, bytes, firstMs: first, totalMs: Math.round(performance.now() - t), error: e.name })); }
    }
  }
} finally { catalog.close(); app.quit(); }
});
