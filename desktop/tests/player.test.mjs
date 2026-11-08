import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

globalThis.window = new EventTarget();
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const instances = [];
class FakeAudio extends EventTarget {
  constructor() { super(); this.src = ''; this.paused = true; this.currentTime = 0; this.duration = 120; this.buffered = { length: 1, start: () => 0, end: () => 60 }; instances.push(this); }
  load() {}
  pause() { this.paused = true; }
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  removeAttribute() { this.src = ''; this.currentTime = 0; }
  getAttribute() { return this.src; }
}
globalThis.Audio = FakeAudio;
const node = () => ({ connect() {}, gain: { setTargetAtTime() {} }, threshold: {}, ratio: {} });
globalThis.AudioContext = class { currentTime = 0; destination = {}; createGain = node; createDynamicsCompressor = node; createMediaElementSource = node; resume = async () => {}; };
const source = stripTypeScriptTypes(fs.readFileSync('src/lib/desktop.ts', 'utf8'));
const { createDesktopBridge } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const tick = () => new Promise(r => setImmediate(r));
const item = (key, id = 'aaaaaaaaaaa') => ({ id, key, title: key, author_name: 'Artist' });
const api = resolve => ({ invoke: async (method, args) => method === 'bootstrap' ? { version: 'test', jobs: [] } : resolve(args), onDownloads() {} });

test('duplicate entries keep independent keys; edits retain current position and paused state', async () => {
  const bridge = createDesktopBridge(api(async ({ id }) => ({ url: 'https://example.invalid/' + id, format: 'test' })));
  bridge.playQueue(JSON.stringify([item('first'), item('second'), item('third')]), 0, 0);
  await tick(); bridge.control('seek', 35); bridge.control('pause');
  bridge.editQueue('third', -1); bridge.editQueue('second', 0);
  let state = JSON.parse(bridge.state());
  assert.equal(state.time, 35); assert.equal(state.key, 'first'); assert.equal(state.playing, false); assert.equal(state.count, 2);
  bridge.control('next'); await tick(); state = JSON.parse(bridge.state());
  assert.equal(state.key, 'third'); assert.equal(state.playing, true);
});

test('late resolution cannot replace a new selection; pause while preparing stays paused', async () => {
  const pending = new Map();
  const bridge = createDesktopBridge(api(({ id }) => new Promise(resolve => pending.set(id, resolve))));
  bridge.playQueue(JSON.stringify([item('old', 'aaaaaaaaaaa')]), 0, 0);
  bridge.playQueue(JSON.stringify([item('new', 'bbbbbbbbbbb')]), 0, 0);
  bridge.control('pause');
  pending.get('bbbbbbbbbbb')({ url: 'https://example.invalid/new', format: 'test' }); await tick();
  pending.get('aaaaaaaaaaa')({ url: 'https://example.invalid/old', format: 'test' }); await tick();
  assert.equal(JSON.parse(bridge.state()).key, 'new');
  assert.equal(JSON.parse(bridge.state()).playing, false);
  const audio = instances.at(-2); assert.equal(audio.src, 'https://example.invalid/new'); assert.equal(audio.paused, true);
});

test('automatic transition and repeat keep the selected queue occurrence', async () => {
  const bridge = createDesktopBridge(api(async ({ id }) => ({ url: 'https://example.invalid/' + id, format: 'test' })));
  bridge.playQueue(JSON.stringify([item('first'), item('duplicate')]), 0, 0); await tick();
  const audio = instances.at(-2); audio.dispatchEvent(new Event('ended')); await tick();
  assert.equal(JSON.parse(bridge.state()).key, 'duplicate');
  bridge.setRepeat(2); audio.currentTime = 120; audio.dispatchEvent(new Event('ended')); await tick();
  assert.equal(JSON.parse(bridge.state()).key, 'duplicate'); assert.equal(JSON.parse(bridge.state()).time, 0);
  bridge.control('pause');
});
