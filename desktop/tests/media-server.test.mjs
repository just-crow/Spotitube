import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaServer } from '../media-server.mjs';

test('offline byte ranges, opaque app origin, and rejection of foreign origins', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spotitube-media-'));
  const file = path.join(directory, 'track'); fs.writeFileSync(file, Buffer.from('0123456789'));
  const server = await createMediaServer({}, { local: () => file, mime: () => 'audio/webm' }, () => { throw new Error('Offline must not access the internet'); });
  try {
    const url = server.url('aaaaaaaaaaa');
    let response = await fetch(url, { headers: { Range: 'bytes=2-5', Origin: 'null' } });
    assert.equal(response.status, 206); assert.equal(await response.text(), '2345');
    assert.equal(response.headers.get('access-control-allow-origin'), 'null');
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    response = await fetch(url, { headers: { Range: 'bytes=-3' } }); assert.equal(await response.text(), '789');
    response = await fetch(url, { headers: { Range: 'bytes=11-' } }); assert.equal(response.status, 416);
    response = await fetch(url, { headers: { Origin: 'https://untrusted.example' } }); assert.equal(response.status, 403);
    response = await fetch(url.replace(/[a-f0-9]{64}/, 'wrong')); assert.equal(response.status, 403);
  } finally { server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('online open-ended requests are bounded and retain upstream content ranges', async () => {
  let requested;
  const server = await createMediaServer({ resolve: async () => ({ url: 'https://test.googlevideo.com/audio', headers: {} }) }, { local: () => null }, async (_url, init) => {
    requested = init.headers.Range;
    return new Response('audio', { status: 206, headers: { 'Content-Type': 'audio/webm', 'Content-Range': 'bytes 0-4/1000000', 'Content-Length': '5' } });
  });
  try {
    const response = await fetch(server.url('aaaaaaaaaaa'), { headers: { Range: 'bytes=0-' } });
    assert.equal(await response.text(), 'audio'); assert.equal(response.status, 206);
    assert.equal(requested, 'bytes=0-524287');
    assert.equal(response.headers.get('content-range'), 'bytes 0-4/1000000');
  } finally { server.close(); }
});
