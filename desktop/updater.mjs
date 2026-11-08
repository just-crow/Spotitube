/** Small, testable state adapter around electron-updater's verified NSIS downloads. */
export class DesktopUpdater {
  constructor(updater, { packaged, version, changed = () => {} }) {
    this.updater = updater; this.packaged = packaged; this.changed = changed;
    this.state = { status: packaged ? 'idle' : 'unsupported', version, percent: 0, transferred: 0, total: 0 };
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.disableDifferentialDownload = true;
    updater.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
    updater.on('update-available', info => this.set({ status: 'downloading', availableVersion: info.version, percent: 0, error: '' }));
    updater.on('update-not-available', () => this.set({ status: 'up-to-date', checkedAt: Date.now(), error: '' }));
    updater.on('download-progress', progress => this.set({ status: 'downloading', percent: Math.min(100, Math.max(0, progress.percent || 0)), transferred: progress.transferred, total: progress.total }));
    updater.on('update-downloaded', info => this.set({ status: 'ready', availableVersion: info.version, percent: 100, error: '' }));
    updater.on('error', () => this.set({ status: 'error', error: 'Could not check or download the update. Check your connection and try again.' }));
  }
  snapshot() { return { ...this.state }; }
  set(value) { Object.assign(this.state, value); this.changed(this.snapshot()); }
  async check() {
    if (!this.packaged || ['checking', 'downloading', 'ready'].includes(this.state.status)) return this.snapshot();
    this.set({ status: 'checking', error: '' });
    try { await this.updater.checkForUpdates(); }
    catch { this.set({ status: 'error', error: 'Could not check or download the update. Check your connection and try again.' }); }
    return this.snapshot();
  }
  install() {
    if (this.state.status !== 'ready') return false;
    // Silent per-user NSIS update, then relaunch. No install happens during playback.
    this.updater.quitAndInstall(true, true); return true;
  }
  start() {
    if (!this.packaged) return;
    this.first = setTimeout(() => void this.check(), 10000); this.first.unref?.();
    this.interval = setInterval(() => void this.check(), 6 * 60 * 60 * 1000); this.interval.unref?.();
  }
  close() { clearTimeout(this.first); clearInterval(this.interval); }
}
