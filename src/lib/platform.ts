import type { Entry, NativeState, Video } from '../types';
import { createDesktopBridge, desktopAPI } from './desktop';

/**
 * Dual native bridge.
 * - Android: synchronous @JavascriptInterface (window.SpotitubeAndroid).
 * - iOS: WKWebView message handler (window.webkit.messageHandlers.spotitube) —
 *   no synchronous return exists, so calls are promise-based with ids, and
 *   state/events are pushed in via __spotMessage / __spotEvent globals.
 */

type AndroidBridge = {
  state(): string;
  playQueue(json: string, startIndex: number, startPositionMs: number): void;
  enqueue(json: string): void;
  setRepeat(mode: number): void;
  control(action: string, value?: number): void;
  search(query: string, request: number, musicOnly: boolean): void;
  radio(id: string, request: number, musicOnly: boolean): void;
  importPlaylist(id: string): void;
  metadata(id: string): string | Promise<string>;
  download(id: string, title: string, artist: string, thumb: string): void;
  deleteDownload(id: string): void;
  downloads(): string;
  downloadQueue(): string;
  artist(url: string, request: number): void;
  setNormalize(enabled: boolean): void;
  appVersion(): string;
  checkUpdates(): void;
  editQueue(key: string, direction: number): void;
  cancelDownload(id: string): void;
  retryDownload(id: string): void;
};

type IosMessage = {
  id?: number;
  method?: string;
  args?: Record<string, unknown>;
};

const androidBridge: AndroidBridge | undefined = desktopAPI ? createDesktopBridge(desktopAPI)
  : (window as unknown as { SpotitubeAndroid?: AndroidBridge }).SpotitubeAndroid;

const iosBridge: { postMessage(message: IosMessage): void } | undefined =
  (window as unknown as { webkit?: { messageHandlers?: { spotitube?: { postMessage(m: IosMessage): void } } } })
    .webkit?.messageHandlers?.spotitube;

export const isDesktop = Boolean(desktopAPI);
export const isAndroidNative = Boolean(androidBridge) && !isDesktop;
export const isIOS = Boolean(iosBridge);
export const isNative = Boolean(androidBridge) || isIOS;

if (isAndroidNative) document.documentElement.classList.add('android-app');
if (isDesktop) document.documentElement.classList.add('desktop-app');
if (iosBridge) document.documentElement.classList.add('ios-app');

export type SearchEvent = { request: number; videos: Video[] | null };
export type RadioEvent = { request: number; seed?: string; videos: Video[] | null };
export type DownloadEvent = {
  id: string;
  status: 'downloading' | 'done' | 'error' | 'removed';
  progress: number;
  received: number;
  total: number;
};
export type ArtistPlaylist = { id: string; title: string; count: number; thumbnail_url: string };
export type ArtistInfo = {
  name: string;
  description: string;
  avatar_url: string;
  channel_url: string;
  subscribers?: number;
  uploads: Video[];
  playlists: ArtistPlaylist[];
};
export type ArtistEvent = { request: number; artist: ArtistInfo | null };

/* ---------- downloads queue (push-updated by the native side) ---------- */

export type DownloadJob = {
  id: string;
  title: string;
  author_name: string;
  thumbnail_url: string;
  status: 'queued' | 'preparing' | 'downloading' | 'completed' | 'failed' | 'canceled';
  received: number;
  total: number;
  at: number;
};

let cachedDownloadJobs: DownloadJob[] = [];
let appVersion = 'development';
window.addEventListener(
  'spotitube-downloads',
  ((event: CustomEvent<DownloadJob[]>) => {
    cachedDownloadJobs = Array.isArray(event.detail) ? event.detail : [];
  }) as EventListener,
);
window.addEventListener(
  'spotitube-state',
  ((event: CustomEvent<NativeState & { version?: string }>) => {
    if (event.detail?.version) appVersion = event.detail.version;
  }) as EventListener,
);

export function nativeDownloadQueue(): DownloadJob[] {
  if (androidBridge?.downloadQueue) {
    try {
      const parsed = JSON.parse(androidBridge.downloadQueue());
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return cachedDownloadJobs;
}

export function nativeCancelDownload(id: string): void {
  if (androidBridge) return androidBridge.cancelDownload(id);
  iosBridge?.postMessage({ method: 'cancelDownload', args: { id } });
}

export function nativeRetryDownload(id: string): void {
  if (androidBridge) return androidBridge.retryDownload(id);
  iosBridge?.postMessage({ method: 'retryDownload', args: { id } });
}

export function nativeEditQueue(key: string, direction: number): void {
  if (androidBridge) return androidBridge.editQueue(key, direction);
  iosBridge?.postMessage({ method: 'editQueue', args: { key, direction } });
}

export function nativeAppVersion(): string {
  if (androidBridge) return androidBridge.appVersion();
  return appVersion;
}

export function nativeCheckUpdates(): void {
  if (androidBridge) return androidBridge.checkUpdates();
  iosBridge?.postMessage({ method: 'checkUpdates', args: {} });
}

export function onNativeEvent<T>(name: string, handler: (detail: T) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<T>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}

/* ---------- iOS request/response plumbing ---------- */

const iosInflight = new Map<number, (result: unknown) => void>();
let iosRequestId = 0;

function iosCall<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const id = ++iosRequestId;
  return new Promise<T>((resolve) => {
    iosInflight.set(id, (result) => resolve(result as T));
    iosBridge!.postMessage({ id, method, args });
  });
}

// Injected by the WebController: resolves pending iosCall()s and re-dispatches events.
(window as unknown as { __spotMessage?: (message: { id: number; result: unknown }) => void }).__spotMessage = (
  message,
) => {
  const pending = iosInflight.get(message.id);
  if (!pending) return;
  iosInflight.delete(message.id);
  pending(message.result);
};

(window as unknown as { __spotEvent?: (name: string, detail: unknown) => void }).__spotEvent = (
  name,
  detail,
) => {
  window.dispatchEvent(new CustomEvent(name, { detail }));
};

/* ---------- shared event surface ---------- */

let cachedState: NativeState | null = null;
window.addEventListener('spotitube-state', ((event: CustomEvent<NativeState>) => {
  cachedState = event.detail ?? null;
}) as EventListener);

export function nativeState(): NativeState | null {
  if (androidBridge) {
    try {
      return JSON.parse(androidBridge.state());
    } catch {
      return null;
    }
  }
  return cachedState;
}

export function onAppEvent<T>(name: string, handler: (detail: T) => void): () => void {
  return onNativeEvent<T>(name, handler);
}

/* ---------- verbs ---------- */

export function nativeControl(action: string, value = 0): void {
  if (androidBridge) return androidBridge.control(action, value);
  iosBridge?.postMessage({ method: 'control', args: { action, value } });
}

export function nativeSearch(query: string, request: number, musicOnly = true): void {
  if (androidBridge) return androidBridge.search(query, request, musicOnly);
  iosBridge?.postMessage({ method: 'search', args: { query, request, musicOnly } });
}

export function nativeImportPlaylist(id: string): void {
  if (androidBridge) return androidBridge.importPlaylist(id);
  iosBridge?.postMessage({ method: 'importPlaylist', args: { id } });
}

const queuePayload = (items: Entry[]) =>
  items.map((item) => ({
    id: item.video.id,
    title: item.video.title,
    author_name: item.video.author_name,
    key: item.key,
  }));

export function nativePlayQueue(items: Entry[], startIndex: number, startPositionMs = 0): void {
  const args = {
    items: queuePayload(items),
    startIndex: Math.max(0, startIndex),
    positionMs: Math.max(0, Math.floor(startPositionMs)),
  };
  if (androidBridge) return androidBridge.playQueue(JSON.stringify(args.items), args.startIndex, args.positionMs);
  iosBridge?.postMessage({ method: 'playQueue', args });
}

export function nativeEnqueue(items: Entry[]): void {
  if (!items.length) return;
  const args = { items: queuePayload(items) };
  if (androidBridge) return androidBridge.enqueue(JSON.stringify(args.items));
  iosBridge?.postMessage({ method: 'enqueue', args });
}

export function nativeSetRepeat(mode: number): void {
  const value = mode === 2 ? 2 : mode === 1 ? 1 : 0;
  if (androidBridge) return androidBridge.setRepeat(value);
  iosBridge?.postMessage({ method: 'setRepeat', args: { mode: value } });
}

export function nativeSetNormalize(enabled: boolean): void {
  if (androidBridge) return androidBridge.setNormalize(enabled);
  iosBridge?.postMessage({ method: 'setNormalize', args: { enabled } });
}

export function nativeDownload(video: Video): void {
  const args = { id: video.id, title: video.title, artist: video.author_name, thumb: video.thumbnail_url };
  if (androidBridge) return androidBridge.download(args.id, args.title, args.artist, args.thumb);
  iosBridge?.postMessage({ method: 'download', args });
}

export function nativeDeleteDownload(id: string): void {
  if (androidBridge) return androidBridge.deleteDownload(id);
  iosBridge?.postMessage({ method: 'deleteDownload', args: { id } });
}

export type OfflineItem = {
  id: string;
  title: string;
  author_name: string;
  thumbnail_url: string;
  size: number;
  at: number;
};

export async function nativeDownloads(): Promise<OfflineItem[]> {
  if (androidBridge) {
    try {
      const parsed = JSON.parse(androidBridge.downloads());
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (!iosBridge) return [];
  try {
    const result = await iosCall<OfflineItem[]>('downloads', {});
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export function nativeArtist(channelUrl: string, request: number): void {
  if (androidBridge) return androidBridge.artist(channelUrl, request);
  iosBridge?.postMessage({ method: 'artist', args: { url: channelUrl, request } });
}

export async function fetchMetadata(id: string): Promise<Video> {
  if (androidBridge) {
    const raw = await androidBridge.metadata(id) || '{}';
    const metadata = JSON.parse(raw) as Partial<Video>;
    if (!metadata.title) throw new Error('YouTube could not load this video.');
    return {
      id,
      title: metadata.title,
      author_name: metadata.author_name || '',
      thumbnail_url: metadata.thumbnail_url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    };
  }
  if (iosBridge) {
    const metadata = await iosCall<Partial<Video> | null>('metadata', { id });
    if (!metadata?.title) throw new Error('YouTube could not load this video.');
    return {
      id,
      title: metadata.title,
      author_name: metadata.author_name || '',
      thumbnail_url: metadata.thumbnail_url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      ...(metadata.duration !== undefined ? { duration: metadata.duration } : {}),
    };
  }
  const response = await fetch(
    '/metadata?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id),
  );
  if (!response.ok) throw new Error('YouTube could not load this video.');
  const metadata = (await response.json()) as Partial<Video>;
  if (!metadata.title) throw new Error('YouTube could not load this video.');
  return {
    id,
    title: metadata.title,
    author_name: metadata.author_name || '',
    thumbnail_url: metadata.thumbnail_url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  };
}

export async function webSearch(query: string): Promise<Video[]> {
  const response = await fetch('/api/search?q=' + encodeURIComponent(query));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'YouTube search is unavailable.');
  return data as Video[];
}

export async function fetchAudioStream(id: string): Promise<string> {
  const response = await fetch('/api/audio?id=' + encodeURIComponent(id));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'YouTube audio could not be resolved.');
  return data.stream as string;
}

/**
 * Native radio uses related streams / a mix of search matches. The web build
 * has no radio endpoint, so it approximates with a search and emits the same event.
 */
export function requestRadio(video: Video, request: number, musicOnly = true): void {
  if (androidBridge) {
    androidBridge.radio(video.id, request, musicOnly);
    return;
  }
  if (iosBridge) {
    iosBridge.postMessage({ method: 'radio', args: { id: video.id, request, musicOnly } });
    return;
  }
  const query = `${video.title} ${video.author_name}`.slice(0, 120);
  webSearch(query)
    .then((videos) =>
      window.dispatchEvent(
        new CustomEvent<RadioEvent>('spotitube-radio', {
          detail: { request, seed: video.id, videos: videos.filter((item) => item.id !== video.id) },
        }),
      ),
    )
    .catch(() =>
      window.dispatchEvent(
        new CustomEvent<RadioEvent>('spotitube-radio', {
          detail: { request, seed: video.id, videos: [] },
        }),
      ),
    );
}
