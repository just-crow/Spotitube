import type { NativeState } from '../types';

type DesktopAPI = {
  invoke(method: string, args?: Record<string, unknown>): Promise<any>;
  onDownloads(listener: (jobs: any[]) => void): () => void;
};
export const desktopAPI = (window as unknown as { SpotitubeDesktop?: DesktopAPI }).SpotitubeDesktop;
type Item = { id: string; key: string; title: string; author_name: string };

/** The desktop transport lives outside React, so navigation never recreates playback. */
export function createDesktopBridge(api: DesktopAPI) {
  let audio = new Audio(); audio.preload = 'auto'; audio.crossOrigin = 'anonymous';
  let items: Item[] = [], index = 0, repeat = 0, desired = false, generation = 0;
  let preparing = false, buffering = false, failure = '', ended = false;
  let volume = 100, positionVersion = 0, retry = 0, format = '', version = 'Desktop';
  let jobs: any[] = [], preloaded = '', preloadedFormat = '', retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAdvanceAt = Date.now(), lastTime = 0, healthySince = Date.now();
  let preloadGeneration = 0;
  let context: AudioContext | undefined, gain: GainNode | undefined, compressor: DynamicsCompressorNode | undefined;
  let normalize = false, retrying = false;
  let nextAudio = new Audio(); nextAudio.preload = 'auto'; nextAudio.crossOrigin = 'anonymous';
  const sources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
  let connected: MediaElementAudioSourceNode | undefined;
  const emit = (name: string, detail: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));
  const invoke = (method: string, args: Record<string, unknown> = {}) => api.invoke(method, args);
  api.onDownloads(value => { jobs = value; emit('spotitube-downloads', value); });
  void invoke('bootstrap').then(data => { version = data.version; jobs = data.jobs; }).catch(console.error);

  function applyGain() {
    if (!context) {
      context = new AudioContext(); gain = context.createGain(); compressor = context.createDynamicsCompressor();
      gain!.connect(compressor); compressor.connect(context.destination);
    }
    let source = sources.get(audio);
    if (!source) { source = context.createMediaElementSource(audio); sources.set(audio, source); }
    if (connected !== source) { connected?.disconnect?.(); source!.connect(gain!); connected = source; }
    gain!.gain.setTargetAtTime(volume / 100, context.currentTime, 0.025);
    compressor!.threshold.value = normalize ? -20 : 0; compressor!.ratio.value = normalize ? 4 : 1;
    void context.resume();
  }
  function state(): NativeState {
    let buffered = 0;
    for (let n = 0; n < audio.buffered.length; n++) if (audio.buffered.start(n) <= audio.currentTime + 0.2 && audio.buffered.end(n) >= audio.currentTime) buffered = audio.buffered.end(n);
    return { playing: desired && !audio.paused && !buffering && !preparing, time: audio.currentTime || 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0, loading: buffering, preparing,
      buffered, key: items[index]?.key, index, count: items.length, editableQueue: true, ended, volume,
      positionVersion, error: failure, sampleAgeMs: 0 };
  }
  function resetPreload() { preloadGeneration++; preloaded = ''; nextAudio.pause(); nextAudio.removeAttribute('src'); nextAudio.load(); void invoke('cancelPreload').catch(() => {}); }
  function upcoming() { return items[index + 1] || (repeat === 1 ? items[0] : undefined); }
  function preload() {
    const next = upcoming(); if (!next || preparing || buffering || !desired || failure || next.key === preloaded) return;
    preloaded = next.key;
    const token = generation;
    const warmToken = ++preloadGeneration;
    // Resolve the following address early; actual network buffering only starts with headroom.
    void invoke('resolve', { id: next.id, purpose: 'preload' }).then(stream => {
      if (generation !== token || preloadGeneration !== warmToken || preloaded !== next.key) return;
      if ((state().buffered || 0) - audio.currentTime >= 30) { preloadedFormat = stream.format; nextAudio.preload = 'auto'; nextAudio.src = stream.url; nextAudio.load(); }
      else preloaded = '';
    }).catch(() => { if (preloadGeneration === warmToken) preloaded = ''; });
  }
  async function load(at: number, position = 0, refresh = false) {
    clearTimeout(retryTimer); retrying = false;
    const item = items[at]; if (!item) return;
    const token = ++generation; index = at; ended = false; failure = ''; preparing = true; buffering = false;
    const readyNext = !refresh && !position && preloaded === item.key && nextAudio.readyState >= 2;
    audio.pause();
    if (readyNext) { [audio, nextAudio] = [nextAudio, audio]; format = preloadedFormat; }
    else { audio.removeAttribute('src'); audio.load(); }
    resetPreload(); positionVersion++; lastAdvanceAt = Date.now(); lastTime = 0;
    try {
      const stream = readyNext ? null : await invoke('resolve', { id: item.id, refresh, purpose: 'playback' });
      if (token !== generation) return;
      if (stream) { format = stream.format; audio.src = stream.url; }
      audio.onloadedmetadata = () => { if (token === generation && position > 0) audio.currentTime = Math.min(position, Math.max(0, audio.duration - 0.1)); };
      if (!readyNext) audio.load(); preparing = false; buffering = desired; lastAdvanceAt = Date.now();
      if (navigator.mediaSession) navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, artist: item.author_name });
      if (desired) { applyGain(); await audio.play(); }
    } catch (error) {
      if (token !== generation) return;
      preparing = false; recover(error);
    }
  }
  function recover(error: unknown) {
    if (!desired && error instanceof DOMException && error.name === 'AbortError') return;
    if (retrying) return;
    buffering = false; preparing = false;
    if (!desired) { failure = 'Playback failed. Retry when you are ready.'; return; }
    if (!navigator.onLine) { failure = 'Waiting for internet…'; return; }
    if (retry < 3) {
      const position = audio.currentTime || 0, token = generation, delay = [1000, 3000, 8000][retry++];
      retrying = true; buffering = true;
      retryTimer = setTimeout(() => { if (token === generation && desired) void load(index, position, true); else retrying = false; }, delay);
    } else failure = 'Playback failed. The stream could not be played. Retry or choose another song.';
    console.warn('Desktop playback:', error instanceof Error ? error.name : 'stream error');
  }
  function bind(element: HTMLAudioElement) {
  element.addEventListener('playing', () => { if (element !== audio) return; buffering = false; preparing = false; failure = ''; healthySince = lastAdvanceAt = Date.now(); preload(); });
  element.addEventListener('waiting', () => { if (element !== audio) return; if (desired) buffering = true; resetPreload(); });
  element.addEventListener('error', () => { if (element === audio && audio.getAttribute('src')) recover(audio.error); });
  element.addEventListener('progress', () => { if (element === audio) preload(); else if (element.buffered.length && element.buffered.end(0) >= 15) element.preload = 'none'; });
  element.addEventListener('ended', () => {
    if (element !== audio) return;
    if (repeat === 2) { audio.currentTime = 0; positionVersion++; if (desired) void audio.play(); return; }
    if (index + 1 < items.length || repeat === 1) { retry = 0; void load(index + 1 < items.length ? index + 1 : 0); }
    else { ended = true; desired = false; }
  });
  }
  bind(audio); bind(nextAudio);
  const watchdog = setInterval(() => {
    if (!desired || preparing || retrying || failure || ended) { lastAdvanceAt = Date.now(); return; }
    if (Math.abs(audio.currentTime - lastTime) > .05) { lastTime = audio.currentTime; lastAdvanceAt = Date.now(); if (Date.now() - healthySince > 15000) retry = 0; }
    else if (Date.now() - lastAdvanceAt > 12000) recover(new Error('Audio transfer stalled'));
  }, 1000);
  (watchdog as unknown as { unref?: () => void }).unref?.();
  window.addEventListener('online', () => { if (desired && failure === 'Waiting for internet…') { retry = 0; void load(index, audio.currentTime, true); } });
  if ('mediaSession' in navigator) {
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack'] as MediaSessionAction[]) {
      navigator.mediaSession.setActionHandler(action, () => control({ nexttrack: 'next', previoustrack: 'prev' }[action as string] || action));
    }
    navigator.mediaSession.setActionHandler('seekto', event => control('seek', event.seekTime || 0));
  }
  function control(action: string, value = 0) {
    if (action === 'play') {
      desired = true; ended = false; applyGain();
      if (!audio.src && items.length) void load(index); else if (!preparing && !retrying) void audio.play().catch(recover);
    } else if (action === 'pause') { desired = false; audio.pause(); buffering = false; clearTimeout(retryTimer); retrying = false; positionVersion++; }
    else if (action === 'seek') { if (Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(value, audio.duration)); positionVersion++; }
    else if (action === 'volume') { volume = Math.max(0, Math.min(300, value)); applyGain(); }
    else if (action === 'retry') { retry = 0; desired = true; void load(index, audio.currentTime, true); }
    else if (action === 'next' || action === 'prev') {
      if (action === 'prev' && audio.currentTime > 3) { audio.currentTime = 0; positionVersion++; return; }
      const target = index + (action === 'next' ? 1 : -1);
      if (target >= 0 && target < items.length) { desired = true; retry = 0; void load(target); }
    }
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = desired ? 'playing' : 'paused';
  }
  function eventRequest(method: string, args: Record<string, unknown>, name: string, detail: Record<string, unknown>, field: string) {
    void invoke(method, args).then(result => emit(name, { ...detail, [field]: result })).catch(() => emit(name, { ...detail, [field]: null }));
  }
  return {
    state: () => JSON.stringify(state()), appVersion: () => version,
    checkUpdates: () => { void invoke('checkUpdates'); },
    metadata: async (id: string) => JSON.stringify(await invoke('metadata', { id })),
    playQueue(json: string, startIndex: number, positionMs: number) {
      items = JSON.parse(json); index = startIndex; desired = true; retry = 0;
      if (navigator.mediaSession && items[index]) navigator.mediaSession.metadata = new MediaMetadata({ title: items[index].title, artist: items[index].author_name });
      void load(index, positionMs / 1000);
    },
    enqueue(json: string) { items.push(...JSON.parse(json)); resetPreload(); preload(); },
    editQueue(key: string, direction: number) {
      const at = items.findIndex(item => item.key === key); if (at <= index) return;
      if (!direction) items.splice(at, 1);
      else { const target = Math.max(index + 1, Math.min(items.length - 1, at + direction)); const [item] = items.splice(at, 1); items.splice(target, 0, item); }
      resetPreload(); preload();
    },
    setRepeat(mode: number) { repeat = mode; resetPreload(); preload(); }, control,
    search: (query: string, request: number, musicOnly: boolean) => eventRequest('search', { query, musicOnly }, 'spotitube-search', { request }, 'videos'),
    radio: (id: string, request: number, musicOnly: boolean) => eventRequest('radio', { id, musicOnly }, 'spotitube-radio', { request, seed: id }, 'videos'),
    importPlaylist: (id: string) => eventRequest('playlist', { id }, 'spotitube-playlist', { id }, 'playlist'),
    artist: (url: string, request: number) => eventRequest('artist', { url }, 'spotitube-artist', { request }, 'artist'),
    download: (id: string, title: string, artist: string, thumb: string) => { void invoke('download', { id, title, artist, thumb }); },
    deleteDownload: (id: string) => { void invoke('deleteDownload', { id }); },
    cancelDownload: (id: string) => { void invoke('cancelDownload', { id }); },
    retryDownload: (id: string) => { void invoke('retryDownload', { id }); },
    downloads: () => JSON.stringify(jobs.filter(j => j.status === 'completed').map(j => ({ ...j, size: j.received }))),
    downloadQueue: () => JSON.stringify(jobs),
    setNormalize(enabled: boolean) { normalize = enabled; if (context) applyGain(); },
  };
}
