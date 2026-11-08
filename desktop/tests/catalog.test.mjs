import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../catalog.mjs';

const sample = { url: 'https://test.googlevideo.com/audio', acodec: 'opus', abr: 135, http_headers: {} };
test('waits for stream readiness and reuses the verified address without extracting again', async () => {
  let extractions = 0, probes = 0, probeAt = 0;
  const start = Date.now();
  const catalog = new Catalog('', { activationDelayMs: 25, fetcher: async (_url, init) => {
    probes++; probeAt = Date.now(); assert.equal(init.headers.Range, 'bytes=0-1023');
    return new Response('audio', { status: 206, headers: { 'Content-Type': 'audio/webm' } });
  } });
  catalog.run = async () => { extractions++; return sample; };
  const first = await catalog.resolve('aaaaaaaaaaa');
  assert.ok(probeAt - start >= 20);
  assert.equal(await catalog.resolve('aaaaaaaaaaa'), first);
  assert.equal(extractions, 1); assert.equal(probes, 1);
});
test('canceling obsolete preparation prevents probe and cache writes', async () => {
  let probes = 0;
  const catalog = new Catalog('', { activationDelayMs: 100, fetcher: async () => { probes++; return new Response(); } });
  catalog.run = async () => sample;
  const controller = new AbortController();
  const result = catalog.resolve('aaaaaaaaaaa', false, controller.signal);
  controller.abort(); await assert.rejects(result, { name: 'AbortError' });
  assert.equal(probes, 0); assert.equal(catalog.streams.size, 0);
});
test('rejected streams never enter the successful-address cache', async () => {
  const catalog = new Catalog('', { activationDelayMs: 0, fetcher: async () => new Response('', { status: 404 }) });
  catalog.run = async () => sample;
  await assert.rejects(catalog.resolve('aaaaaaaaaaa'), /rejected.*404/);
  assert.equal(catalog.streams.size, 0);
});
