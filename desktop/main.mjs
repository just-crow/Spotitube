import { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Catalog, validId } from './catalog.mjs';
import { Downloads } from './downloads.mjs';
import { createMediaServer } from './media-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged([{ scheme: 'spotitube', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
if (process.env.SPOTITUBE_DESKTOP_TEST_PROFILE) app.setPath('userData', path.resolve(process.env.SPOTITUBE_DESKTOP_TEST_PROFILE));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window, catalog, downloads, mediaServer;
let playbackResolution, preloadResolution;
const tools = app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(here, 'tools');
const web = path.join(here, 'web');
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https: wss:; media-src 'self' http://127.0.0.1:* blob:; font-src 'self' https: data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'";

if (locked) app.whenReady().then(async () => {
  catalog = new Catalog(tools, { fetcher: (url, init) => net.fetch(url, init) });
  downloads = new Downloads(path.join(app.getPath('userData'), 'downloads'), catalog, jobs => { if (window && !window.isDestroyed()) window.webContents.send('downloads', jobs); }, (url, init) => net.fetch(url, init));
  mediaServer = await createMediaServer(catalog, downloads, (url, init) => net.fetch(url, init));
  protocol.handle('spotitube', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(web, '.' + relative);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers); headers.set('Content-Security-Policy', csp);
    headers.set('Content-Type', contentTypes[path.extname(file)] || 'application/octet-stream');
    return new Response(response.body, { headers });
  });
  ipcMain.handle('spotitube', async (event, method, args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith('spotitube://app/')) throw new Error('Untrusted caller.');
    switch (method) {
      case 'bootstrap': return { version: app.getVersion() + ' · Windows', jobs: downloads.snapshot() };
      case 'resolve': {
        if (!validId(args.id)) throw new Error('Invalid video.');
        let signal;
        if (args.purpose === 'playback') {
          playbackResolution?.abort(); preloadResolution?.abort();
          playbackResolution = new AbortController(); signal = playbackResolution.signal;
        } else if (args.purpose === 'preload') {
          preloadResolution?.abort(); preloadResolution = new AbortController(); signal = preloadResolution.signal;
        }
        const stream = downloads.local(args.id) ? { format: 'Offline audio', until: 'local', prepareMs: 0 } : await catalog.resolve(args.id, Boolean(args.refresh), signal);
        return { url: `${mediaServer.url(args.id)}?v=${stream.until}`, format: stream.format, prepareMs: stream.prepareMs };
      }
      case 'cancelPreload': preloadResolution?.abort(); return true;
      case 'metadata': return catalog.metadata(args.id);
      case 'search': return catalog.search(args.query, args.musicOnly !== false);
      case 'radio': { const seed = await catalog.metadata(args.id); return (await catalog.search(seed.author_name + ' songs', args.musicOnly !== false)).filter(v => v.id !== args.id); }
      case 'playlist': return catalog.playlist(args.id);
      case 'artist': return catalog.artist(args.url);
      case 'download': downloads.enqueue(args); return true;
      case 'deleteDownload': downloads.remove(args.id); return true;
      case 'cancelDownload': downloads.cancel(args.id); return true;
      case 'retryDownload': downloads.retry(args.id); return true;
      case 'checkUpdates': {
        try {
          const response = await fetch('https://api.github.com/repos/just-crow/Spotitube/releases?per_page=30', { headers: { 'User-Agent': 'Spotitube-desktop' }, signal: AbortSignal.timeout(12000) });
          if (!response.ok) throw new Error('Release service unavailable');
          const releases = await response.json();
          const release = releases.find(item => !item.prerelease && !item.draft && /^desktop-v\d+\.\d+\.\d+$/.test(item.tag_name));
          const latest = release?.tag_name.replace('desktop-v', '');
          const compare = (a, b) => { const left = a.split('.').map(Number), right = b.split('.').map(Number); for (let n = 0; n < 3; n++) if (left[n] !== right[n]) return left[n] - right[n]; return 0; };
          const newer = latest && compare(latest, app.getVersion()) > 0;
          const result = await dialog.showMessageBox(window, { type: 'info', title: 'Spotitube desktop updates', message: newer ? `Spotitube ${latest} is available` : 'You have the latest desktop version', detail: `Installed version: ${app.getVersion()}. Your library stays on this computer when you update.`, buttons: newer ? ['Open download', 'Later'] : ['Close'], defaultId: newer ? 1 : 0, cancelId: newer ? 1 : 0 });
          if (newer && result.response === 0 && /^https:\/\/github\.com\/just-crow\/Spotitube\/releases\//.test(release.html_url)) await shell.openExternal(release.html_url);
        } catch {
          const result = await dialog.showMessageBox(window, { type: 'warning', title: 'Spotitube desktop updates', message: 'Could not check for updates', detail: 'Check your internet connection or open the releases page to check manually.', buttons: ['Open releases', 'Close'], defaultId: 1, cancelId: 1 });
          if (result.response === 0) await shell.openExternal('https://github.com/just-crow/Spotitube/releases');
        }
        return true;
      }
      default: throw new Error('Unsupported operation.');
    }
  });
  window = new BrowserWindow({ width: 1400, height: 900, minWidth: 860, minHeight: 620, backgroundColor: '#080a09', title: 'Spotitube', icon: path.join(here, 'icon.png'), show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, spellcheck: false } });
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('spotitube://app/')) { event.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.on('before-input-event', (event, input) => { if (input.control && ['+', '-', '=', '0'].includes(input.key)) event.preventDefault(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Spotitube', submenu: [{ label: 'Check for updates', click: () => window.webContents.executeJavaScript('window.SpotitubeDesktop.invoke("checkUpdates")') }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
  ]));
  window.once('ready-to-show', () => window.show());
  await window.loadURL('spotitube://app/');
  await window.webContents.setVisualZoomLevelLimits(1, 1);
  downloads.pump();
});
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { playbackResolution?.abort(); preloadResolution?.abort(); downloads?.close(); catalog?.close(); mediaServer?.close(); });
