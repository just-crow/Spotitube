import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopUpdater } from '../updater.mjs';

class FakeUpdater extends EventEmitter {
  checks = 0; installs = [];
  async checkForUpdates() { this.checks++; this.emit('checking-for-update'); }
  quitAndInstall(...args) { this.installs.push(args); }
}
test('downloads in background, reports progress, and only explicitly restarts once ready', async () => {
  const native = new FakeUpdater(), snapshots = [];
  const updater = new DesktopUpdater(native, { packaged: true, version: '1.0.2', changed: s => snapshots.push(s) });
  assert.equal(native.autoDownload, true); assert.equal(native.autoInstallOnAppQuit, true);
  assert.equal(updater.install(), false);
  await updater.check(); await updater.check(); assert.equal(native.checks, 1);
  native.emit('update-available', { version: '1.0.3' });
  native.emit('download-progress', { percent: 45, transferred: 45, total: 100 });
  assert.equal(updater.snapshot().percent, 45); assert.equal(updater.install(), false);
  native.emit('update-downloaded', { version: '1.0.3' });
  assert.equal(updater.snapshot().status, 'ready'); assert.equal(native.installs.length, 0);
  await updater.check(); assert.equal(native.checks, 1);
  assert.equal(updater.install(), true); assert.deepEqual(native.installs, [[true, true]]);
  assert.notEqual(snapshots[0], snapshots.at(-1)); updater.close();
});
test('failure stays retryable, up-to-date is clear, and development never checks remotely', async () => {
  const native = new FakeUpdater();
  const updater = new DesktopUpdater(native, { packaged: true, version: '1.0.2' });
  native.emit('error', new Error('Private signed URL should not appear in UI'));
  assert.equal(updater.snapshot().status, 'error'); assert.ok(!updater.snapshot().error.includes('signed URL'));
  await updater.check(); native.emit('update-not-available'); assert.equal(updater.snapshot().status, 'up-to-date');
  const devNative = new FakeUpdater(), dev = new DesktopUpdater(devNative, { packaged: false, version: 'dev' });
  await dev.check(); dev.start(); assert.equal(devNative.checks, 0); assert.equal(dev.snapshot().status, 'unsupported');
  dev.close(); updater.close();
});
