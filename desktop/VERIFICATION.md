# Windows desktop 1.0.0 verification

Verified locally on Windows x64, November 8, 2026:

- TypeScript check and production asset build pass.
- Windows NSIS installer builds successfully with the application icon and bundled tools.
- Packaged `win-unpacked/Spotitube.exe` launches without a development server or Python installation.
- Live YouTube metadata and music search return titles, thumbnails, and artist names. Search was checked with Rick Astley and Daft Punk queries.
- Live extracted audio advances and produces a nonzero decoded audio signal (RMS measured with the test window muted).
- A real 3,433,755-byte song download completed and matched the server's expected byte count.
- Completed download survived app restart and played through the packaged application's offline route with a nonzero audio signal. Offline range tests explicitly fail if any internet fetch is attempted.
- Navigating between Library and Offline preserves playback; closing the app ends playback. No test audio is left playing.
- Word-synced lyrics and the animated full-screen panel render in the desktop window.
- Window sizes 860×620, 1024×768, 1366×768, and 1920×1080 have no page-width overflow; the bottom player remains visible.
- Six automated tests cover three concurrent downloads plus queued items, duplicates, cancel/retry, interrupted/corrupt transfers, persistence, offline range requests, origin rejection, stable queue identities, rapid track changes, paused preparation, automatic transitions, and repeat.

Limits: the installer is unsigned; its interactive installation wizard and Windows upgrades have not been exercised. Live playlist pagination, account Sync, OS media keys, prolonged weak-network behavior, and audio output across different sound devices have not received a full end-to-end regression on Windows. Three-download concurrency uses a deterministic local fixture server; one real YouTube download was verified. Linux and macOS builds are not delivered. The Android update feed is unchanged.
