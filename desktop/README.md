# Spotitube for Windows

The Windows app uses the same interface as Android, with its own persistent library, native desktop window, media keys, full-screen lyrics, playlist-link import, search, three concurrent downloads, offline playback, and audio boost. Closing the last window stops playback and exits. Interrupted downloads are safely restarted on the next launch.

## Install

Run `desktop-release/Spotitube-Setup-1.0.4.exe`. Installation is per-user and does not require administrator access. Windows may warn that this release is unsigned. Libraries and downloads are stored in `%APPDATA%/Spotitube`, independently of Android and the browser. Existing app Sync can transfer a library between devices when configured; the installer does not import a browser's storage automatically.

No Python installation, Android emulator, local web server, or API key is required. Internet access is required for YouTube searches and online playback. Previously downloaded songs play offline. Public/unlisted playlists can be imported by link; private account playlists and Google account editing are not added by the desktop port.

## Develop and build (Windows x64, Node 24+)

```powershell
npm ci
npm run desktop:prepare
npm run desktop:dev
npm run desktop:build
```

Preparation downloads the official yt-dlp Windows executable and verifies both its published SHA-256 and the pinned checksum in `desktop/tools-manifest.json`, copies the current Node runtime, and includes their license files. Both tools are bundled with the installer. Rebuild with an updated yt-dlp if YouTube changes extraction; update the version and verified official checksum in the manifest first. No GitHub API token is needed to build. Builds never include `.env.local`, server OAuth secrets, or development configuration. Public `VITE_*` configuration is intentionally bundled, as in the web/Android clients.

`npm run desktop:test` checks queue identity, late playback responses, paused preparation, repeat, download concurrency, cancellation, retries, file validation, restart recovery, offline ranges, duplicate prevention, and updater states without accessing YouTube. `npm run typecheck` checks the shared frontend.

## Automatic updates

The installed Windows app checks ten seconds after launch and every six hours. Updates download in the background, with progress in Settings → App updates. The update installs on normal app exit, or immediately through **Restart and install**. It does not interrupt playing music automatically. Per-user installation and the stable application ID preserve the existing library and downloads. Development/test-profile apps do not auto-update.

Updates use electron-updater's NSIS installer flow and SHA-512 integrity verification. The application/installer is currently unsigned; Windows publisher-signature verification is disabled explicitly for these unsigned personal builds. Update metadata is fetched over HTTPS from `docs/desktop/latest.yml` in this repository and points to immutable GitHub release assets. Android uses its own unchanged update feed.

After verifying a new Windows installer, publish with:

```powershell
npm run desktop:publish -- path/to/release-notes.md
git add docs/desktop/latest.yml
git commit -m "Publish verified desktop update"
git push origin main
```

The publisher verifies the installer against build metadata, uploads the installer/blockmap, checks GitHub's asset SHA-256, and only then writes the feed. Never publish the feed before the installer has passed verification. Retain existing release binaries so older apps can still download referenced versions.

The browser audio engine controls its own network buffer sizes. Next-stream resolution and guarded preloading are provided, but Media3's Android-specific 5/15-second buffering thresholds do not apply to Windows.
