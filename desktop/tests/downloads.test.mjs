import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Downloads } from '../downloads.mjs';

const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee'];
async function until(predicate) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > 8000) throw new Error('Timed out waiting for queue'); await new Promise(r => setTimeout(r, 20)); }
}
test('three jobs, duplicate prevention, cancellation, retry and atomic completion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spotitube-test-'));
  let active = 0, highest = 0;
  const server = http.createServer((_req, res) => {
    active++; highest = Math.max(highest, active);
    let done = false; const finish = () => { if (!done) { done = true; active--; } };
    res.on('close', finish);
    res.writeHead(200, { 'Content-Type': 'audio/webm', 'Content-Length': '1024' });
    res.write(Buffer.alloc(256)); setTimeout(() => { res.end(Buffer.alloc(768)); finish(); }, 200);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const manager = new Downloads(directory, { resolve: async () => ({ url, headers: {} }) }, () => {});
  try {
    ids.forEach(id => manager.enqueue({ id, title: id })); manager.enqueue({ id: ids[0] });
    assert.equal(manager.jobs.length, 5);
    assert.equal(manager.active.size, 3);
    assert.equal(manager.jobs.filter(j => j.status === 'queued').length, 2);
    manager.cancel(ids[1]);
    await until(() => !manager.active.has(ids[1]));
    assert.equal(manager.jobs[1].status, 'canceled');
    assert.equal(fs.existsSync(manager.file(ids[1]) + '.part'), false);
    manager.retry(ids[1]);
    await until(() => manager.jobs.every(j => j.status === 'completed'));
    assert.ok(highest <= 3);
    assert.equal(manager.completed().length, 5);
    assert.equal(fs.statSync(manager.local(ids[0])).size, 1024);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.part')).length, 0);
    const reopened = new Downloads(directory, {}, () => {});
    assert.equal(reopened.completed().length, 5);
    reopened.remove(ids[0]); assert.equal(reopened.local(ids[0]), null);
  } finally { manager.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('rejects incomplete files, retains failed jobs and restarts interrupted jobs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spotitube-test-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/webm', 'Content-Length': '1024' }); res.write('short'); setTimeout(() => res.destroy(), 30);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const manager = new Downloads(directory, { resolve: async () => ({ url: `http://127.0.0.1:${server.address().port}`, headers: {} }) }, () => {});
  try {
    manager.enqueue({ id: ids[0] });
    await until(() => manager.jobs[0].status === 'failed');
    assert.equal(manager.completed().length, 0); assert.equal(fs.existsSync(manager.file(ids[0])), false);
    assert.equal(fs.existsSync(manager.file(ids[0]) + '.part'), false);
    manager.jobs[0].status = 'downloading'; manager.save();
    const reopened = new Downloads(directory, {}, () => {});
    assert.equal(reopened.jobs[0].status, 'queued');
    assert.equal(reopened.jobs[0].received, 0);
    assert.throws(() => reopened.enqueue({ id: '../escape' }));
  } finally { manager.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); }
});
