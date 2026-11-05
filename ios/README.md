# Spotitube (iOS)

Native iOS app: AVFoundation playback, background downloads, and the shared web UI
inside a `WKWebView`. There is no synchronous JS→native channel in WKWebView, so
the bridge is event-based: JS calls `window.webkit.messageHandlers.spotitube`
and native pushes state via `window.__spotEvent(...)` / answers calls with
`window.__spotMessage(...)`. The bundled web app is served over the custom
`spotitube://local/` scheme (same restrictions as spotitube.local on Android).

## Build

Requires macOS, Xcode 15+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```sh
brew install xcodegen        # once
./scripts/sync-ios-web.sh    # copies dist/ into ios/Spotitube/Web
cd ios && xcodegen && open Spotitube.xcodeproj
```

Then select the **Spotitube** scheme and run. On first open, Xcode resolves the
`YouTubeKit` package (pinned revision in `project.yml`) — internet required.

`scripts/sync-ios-web.ps1` is the Windows equivalent for preparing assets.

## What works

- Streaming search + playback (AVPlayer, background audio, lock-screen controls)
- Gapless-ish queue: next track's stream is resolved and buffered ahead
- Radio (related streams), playlist import (public/unlisted), artist pages
- Offline downloads via background `URLSession` (survive app restart)
- Synced lyrics (lrclib), Google-account-free Supabase library sync
- Queue editing (reorder/remove upcoming tracks) — native side supports it

## Known limits / not ported yet

- **Loudness normalization (AutoLeveler) is Android-only.** AVPlayer doesn't let
  us touch PCM without an AVAudioEngine rewrite; the toggle is hidden on iOS.
- **App updates:** iOS has no self-update mechanism; Settings → "Check for
  updates" opens the latest GitHub release page.
- **Icons/signing:** no asset catalog yet (debug builds fine, archive needs
  icons + your own team signing).
- Offline downloads need `YouTubeKit` to resolve audio streams (`.local` then
  `.remote`). If YouTube changes markup, playback resolution breaks for everyone;
  `Catalog.search` etc. parse defensively but test against real links.

## Layout

- `Spotitube/WebController.swift` — WebView host + `spotitube://` scheme handler + message bridge
- `Spotitube/PlaybackEngine.swift` — AVPlayer queue (gapless-ish, preload, repeat, lock screen)
- `Spotitube/DownloadCoordinator.swift` — background downloads (persisted, resumable)
- `Spotitube/Catalog.swift` — YouTube search / radio / playlist import / artist page
- `Spotitube/Models.swift`, `AppDelegate.swift`
- `Tests/`, `UITests/` — unit tests for the catalog parser

JS bridge contract lives in `src/lib/platform.ts` (`__spotMessage`/`__spotEvent`),
which is shared by Android (synchronous bridge) and iOS (promise/event bridge).
