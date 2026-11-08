# Spotitube for Windows

The Windows app uses the same interface as Android, with its own persistent library, native desktop window, media keys, full-screen lyrics, playlist-link import, search, three concurrent downloads, offline playback, and audio boost. Closing the last window stops playback and exits. Interrupted downloads are safely restarted on the next launch.

## Install

Run `desktop-release/Spotitube-Setup-1.0.1.exe`. Installation is per-user and does not require administrator access. Windows may warn that this release is unsigned. Libraries and downloads are stored in `%APPDATA%/Spotitube`, independently of Android and the browser. Existing app Sync can transfer a library between devices when configured; the installer does not import a browser's storage automatically.

No Python installation, Android emulator, local web server, or API key is required. Internet access is required for YouTube searches and online playback. Previously downloaded songs play offline. Public/unlisted playlists can be imported by link; private account playlists and Google account editing are not added by the desktop port.

## Develop and build (Windows x64, Node 24+)

```powershell
npm ci
npm run desktop:prepare
npm run desktop:dev
npm run desktop:build
```

Preparation downloads the official yt-dlp Windows executable and verifies both its published SHA-256 and the pinned checksum in `desktop/tools-manifest.json`, copies the current Node runtime, and includes their license files. Both tools are bundled with the installer. Rebuild with an updated yt-dlp if YouTube changes extraction; update the version and verified official checksum in the manifest first. No GitHub API token is needed to build. Builds never include `.env.local`, server OAuth secrets, or development configuration. Public `VITE_*` configuration is intentionally bundled, as in the web/Android clients.

`npm run desktop:test` checks queue identity, late playback responses, paused preparation, repeat, download concurrency, cancellation, retries, file validation, restart recovery, offline ranges, and duplicate prevention without accessing YouTube. `npm run typecheck` checks the shared frontend. Desktop update checking compares the installed version with published `desktop-v*` GitHub releases and offers the download page; silent automatic installation is not implemented. Windows releases do not change the Android update manifest.

The browser audio engine controls its own network buffer sizes. Next-stream resolution and guarded preloading are provided, but Media3's Android-specific 5/15-second buffering thresholds do not apply to Windows.
