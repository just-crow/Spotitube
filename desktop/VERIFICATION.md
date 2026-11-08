# Windows desktop 1.0.0 verification

## Desktop 1.0.1 loading fix

Reproduced immediate HTTP 403 responses for freshly extracted stream URLs. The **same URL** returned HTTP 206 after a 3.2-second wait: 32 KiB in 54 ms, 256 KiB in 134 ms. The resolver now waits 3.1 seconds and probes readiness before handing a URL to the player; it retries readiness on the same address rather than immediately creating a new unready address. Extraction is bounded to 20 seconds. Actual audio requests are capped at 512 KiB, with a 12-second inactivity timeout refreshed as data arrives. Switching selections cancels obsolete preparation. Prepared next-song playback reuses the same audio element and audio graph.

Measured through the real UI, with a fresh desktop profile and live YouTube streams:

| Song | Cold time to decoded playback |
| --- | ---: |
| Rick Astley — Never Gonna Give You Up | 9,358 ms |
| Daft Punk — One More Time | 8,972 ms |
| Foo Fighters — Everlong | 9,281 ms |

All three played successfully without recovery attempts. The final packaged 1.0.1 application also passed a fresh-profile cold start in 10,815 ms with a non-silent decoded audio signal. A prepared next-song transition took 30 ms and produced a non-silent decoded audio signal. These are local measurements, not a promise of identical timings on other networks. First-time extraction still costs several seconds. Eleven focused automated tests pass, including stream readiness, canceled preparation, rejected-stream cache protection, bounded online ranges, and reuse of the prepared audio element. The phone playback implementation is unchanged.

## Original desktop checks

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
