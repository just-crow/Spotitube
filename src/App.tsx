import { nativeAppVersion } from './lib/platform';
import { nativeCheckUpdates } from './lib/platform';
import { nativeDownloadQueue, nativeCancelDownload, nativeRetryDownload, type DownloadJob } from './lib/platform';
import React, { useEffect, useRef, useState } from 'react';
import type { Entry, Playlist, PlaylistRef, Video } from './types';
import { clock, entry, shuffled, uuid } from './lib/format';
import { KEYS, loadPlaylists, playlistEntries, read, withPlaylistIds, write } from './lib/storage';
import {
  fetchAudioStream,
  fetchMetadata,
  isNative,
  nativeControl,
  nativeDeleteDownload,
  nativeDownload,
  nativeDownloads,
  nativeEnqueue,
  nativeEditQueue,
  nativeImportPlaylist,
  nativePlayQueue,
  nativeSearch,
  nativeSetNormalize,
  nativeSetRepeat,
  nativeArtist,
  nativeState,
  onNativeEvent,
  requestRadio,
  webSearch,
} from './lib/platform';
import type { ArtistEvent, ArtistInfo, DownloadEvent, OfflineItem, RadioEvent, SearchEvent } from './lib/platform';
import type { Session } from '@supabase/supabase-js';
import { currentSession, pullState, pushState, signIn, signOut, signUp, rememberStamp, localStamp, supabase, type ResumePosition } from './lib/supabase';
import { useLyrics } from './hooks/useLyrics';
import { TrackRow } from './components/TrackRow';
import { LyricsPane } from './components/LyricsPane';

const SYNC_ERRORS: Record<string, string> = {
  failed: 'Google sign-in did not complete. Try Connect YouTube again.',
  denied: 'Google did not grant access. Use the account listed under Test users and allow YouTube access.',
  session: 'Sign-in session expired or the browser changed. Start again in the same browser at 127.0.0.1:5173.',
  credentials: 'Google rejected the client credentials. Check the client ID and replacement secret in .env.local.',
  exchange: 'Google could not complete sign-in. Start again and verify the exact redirect URI.',
};

export default function App() {
  const [videos, save] = useState<Video[]>(() => read<Video[]>(KEYS.videos, []));
  const [likes, like] = useState<string[]>(() => read<string[]>(KEYS.likes, []));
  const [history, remember] = useState<string[]>(() => read<string[]>(KEYS.history, []));
  const [recentVideos, setRecentVideos] = useState<Video[]>(() => read<Video[]>(KEYS.recent, []));
  const [listens, setListens] = useState<{ video: Video; at: number }[]>(() => read('spotitube-listens', []));
  const [added, setAdded] = useState<Record<string, number>>(() => read('spotitube-added', {}));
  useEffect(() => { write('spotitube-listens', listens); }, [listens]);
  useEffect(() => { write('spotitube-added', added); }, [added]);
  const [page, navigate] = useState('Home');
  const [musicSearch, setMusicSearch] = useState(() => read('spotitube-music-search', true));
  const [musicRadio, setMusicRadio] = useState(() => read('spotitube-music-radio', true));
  const [blockedVideos, setBlockedVideos] = useState<Record<string,string>>(() => read('spotitube-blocked-videos', {}));
  const [blockedChannels, setBlockedChannels] = useState<Record<string,string>>(() => read('spotitube-blocked-channels', {}));
  const [blockTarget, setBlockTarget] = useState<Video>();
  const recommendations = useRef({ musicRadio, blockedVideos, blockedChannels });
  recommendations.current = { musicRadio, blockedVideos, blockedChannels };
  useEffect(() => { write('spotitube-music-search', musicSearch); }, [musicSearch]);
  useEffect(() => { write('spotitube-music-radio', musicRadio); }, [musicRadio]);
  useEffect(() => { write('spotitube-blocked-videos', blockedVideos); }, [blockedVideos]);
  useEffect(() => { write('spotitube-blocked-channels', blockedChannels); }, [blockedChannels]);
  function channelKey(item: Video) { return (item.channel_url || item.channel_id || '').split(/[?#]/)[0].replace(/\/$/, ''); }
  function allowedRecommendation(item: Video) {
    const options = recommendations.current;
    return !options.blockedVideos[item.id] && !options.blockedChannels[channelKey(item)];
  }

  useEffect(() => {
    const player = document.querySelector('.player');
    if (!player) return;
    const measure = () => document.documentElement.style.setProperty('--player-height',
      Math.ceil(player.getBoundingClientRect().height) + 'px');
    const observer = new ResizeObserver(measure);
    observer.observe(player);
    measure();
    return () => observer.disconnect();
  }, []);
  const searchResultsHeading = useRef<HTMLHeadingElement>(null);
  const [searchScrollRequest, setSearchScrollRequest] = useState(0);
  useEffect(() => {
    if (!searchScrollRequest || page !== 'Search') return;
    const timer = setTimeout(() => {
      searchResultsHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }, 180);
    return () => clearTimeout(timer);
  }, [searchScrollRequest, page]);
  function showSearchResults() {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    navigate('Search');
    setSearchScrollRequest((value) => value + 1);
  }
  const [query, search] = useState('');
  const [url, setUrl] = useState('');
  const [error, fail] = useState('');
  const [busy, loading] = useState(false);
  const [queue, setQueue] = useState<Entry[]>([]);
  const [editableQueue, setEditableQueue] = useState(!isNative);
  const [current, select] = useState<Entry>();
  const [shuffle, toggleShuffle] = useState(false);
  const [repeat, setRepeat] = useState(() => read<number>('spotitube-repeat', 0));
  useEffect(() => { write('spotitube-repeat', repeat); }, [repeat]);
  const [expanded, expand] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const listenSample = useRef({ key: '', time: 0, at: 0, total: 0, counted: false, playing: false });
  useEffect(() => {
    if (!current) return;
    const previous = listenSample.current;
    const at = performance.now();
    const elapsed = (at - previous.at) / 1000;
    const delta = time - previous.time;
    const same = current.key === previous.key;
    const total = (same ? previous.total : 0) +
      (same && playing && previous.playing && delta > 0 && delta <= elapsed + 0.15 ? delta : 0);
    const counted = same && previous.counted;
    listenSample.current = { key: current.key, time, at, total, counted, playing };
    if (!counted && duration > 0 && total >= Math.min(30, duration / 2)) {
      listenSample.current.counted = true;
      const now = Date.now();
      setListens((items) => [{ video: current.video, at: now }, ...items.filter(
        (item) => now - item.at < 30 * 86400_000,
      )].slice(0, 5000));
    }
  }, [current, playing, time, duration]);
  const topTracks = new Map<string, { video: Video; count: number }>();
  for (const item of listens) {
    if (Date.now() - item.at >= 30 * 86400_000) continue;
    topTracks.set(item.video.id, { video: item.video, count: (topTracks.get(item.video.id)?.count ?? 0) + 1 });
  }
  const [volume, setVolume] = useState(isNative ? 100 : 80);
  const [nativeReady, setNativeReady] = useState(false);
  const [playerError, setPlayerError] = useState('');
  const [buffered, setBuffered] = useState(0);
  const [diagnosticLog, setDiagnosticLog] = useState<string[]>([]);
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    if (!isNative || !playerError) return;
    const stage = ['Preparing song…', 'Buffering…', 'Waiting for internet…'].includes(playerError)
      ? playerError : 'Playback failed';
    setDiagnosticLog((log) => [...log.slice(-39), new Date().toISOString() + ' ' + stage]);
  }, [playerError]);
  const [nowView, setNowView] = useState<'art' | 'lyrics'>('art');
  const [lyricsOpenRequest, setLyricsOpenRequest] = useState(0);
  const [lyricsAttempt, setLyricsAttempt] = useState(0);
  const [audioMode, setAudioMode] = useState(true);
  const audio = useRef<HTMLAudioElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const player = useRef<any>(null);
  const ended = useRef(() => {});

  const video = current?.video;

  /* ---------- loudness normalization ---------- */

  const [normalize, setNormalize] = useState(
    () => read<string>('spotitube-normalize', '1') !== '0',
  );
  useEffect(() => {
    write('spotitube-normalize', normalize ? '1' : '0');
    if (isNative) nativeSetNormalize(normalize);
  }, [normalize]);
  useEffect(() => {
    if (isNative) nativeSetNormalize(read<string>('spotitube-normalize', '1') !== '0');
  }, []);

  /* ---------- offline downloads ---------- */

  async function refreshDownloads() {
    if (!isNative) return;
    const items = await nativeDownloads();
    setOfflineItems(items);
    setDownloads(Object.fromEntries(items.map((item) => [item.id, item.size])));
  }

  const [downloads, setDownloads] = useState<Record<string, number>>({});
  const [downloadJobs, setDownloadJobs] = useState<DownloadJob[]>([]);
  useEffect(() => {
    if (!isNative) return;
    const poll = () => {
      const jobs = nativeDownloadQueue();
      setDownloadJobs(jobs);
      setDownloading(Object.fromEntries(jobs.filter((job) => ['queued', 'preparing', 'downloading'].includes(job.status))
        .map((job) => [job.id, job.total > 0 ? job.received / job.total : 0])));
      refreshDownloads();
    };
    poll();
    const interval = setInterval(poll, 700);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [downloading, setDownloading] = useState<Record<string, number>>({});
  const [offlineItems, setOfflineItems] = useState<OfflineItem[]>([]);

  useEffect(
    () =>
      onNativeEvent<DownloadEvent>('spotitube-download', ({ id, status, progress }) => {
        if (status === 'downloading') {
          setDownloading((map) => ({ ...map, [id]: progress }));
          return;
        }
        setDownloading((map) => {
          const next = { ...map };
          delete next[id];
          return next;
        });
        refreshDownloads();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    write(KEYS.videos, videos);
    write(KEYS.likes, likes);
    write(KEYS.history, history);
  }, [videos, likes, history]);
  useEffect(() => {
    write(KEYS.recent, recentVideos);
  }, [recentVideos]);

  useEffect(() => {
    if (!isNative) return;
    const update = () => {
      const state = nativeState();
      if (state && typeof state.volume === 'number') setVolume(state.volume);
    };
    update();
    const timer = setInterval(update, 350);
    return () => clearInterval(timer);
  }, []);

  /* ---------- local playlists ---------- */

  const [playlists, setPlaylists] = useState<Playlist[]>(loadPlaylists);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pick, setPick] = useState<Video>();
  const [actionMessage, setActionMessage] = useState('');
  useEffect(() => {
    if (!actionMessage) return;
    const timeout = setTimeout(() => setActionMessage(''), 3000);
    return () => clearTimeout(timeout);
  }, [actionMessage]);
  const [destination, setDestination] = useState('');
  useEffect(() => {
    write(KEYS.playlists, playlists);
  }, [playlists]);

  const selectedList = playlists.find((playlist) => playlist.id === selectedListId);
  const playlistContext = useRef<string | undefined>(undefined);
  const [resumeLists, setResumeLists] = useState<Record<string, { videoId: string; seconds: number }>>(
    () => read('spotitube-playlist-resume', {}),
  );
  useEffect(() => {
    const id = playlistContext.current;
    if (!id || !current || !playing || time < 1) return;
    setResumeLists((items) => {
      const seconds = Math.floor(time / 5) * 5;
      if (items[id]?.videoId === current.video.id && items[id]?.seconds === seconds) return items;
      return { ...items, [id]: { videoId: current.video.id, seconds } };
    });
  }, [current, playing, time]);
  useEffect(() => { write('spotitube-playlist-resume', resumeLists); }, [resumeLists]);
  const [listQuery, setListQuery] = useState('');
  const [listSort, setListSort] = useState('manual');
  const [listSelection, setListSelection] = useState<number[]>([]);
  const selectionHold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectionStart = useRef({ x: 0, y: 0 });
  const suppressSelectionClick = useRef(false);
  function cancelSelectionHold() {
    clearTimeout(selectionHold.current);
    selectionHold.current = undefined;
  }
  useEffect(() => cancelSelectionHold, [selectedListId]);
  useEffect(() => { setListSelection([]); }, [selectedListId, selectedList?.ids, listQuery, listSort]);
  useEffect(() => { setListQuery(''); setListSort('manual'); }, [selectedListId]);

  /* ---------- YouTube playlists (web sign-in + Android import) ---------- */

  const [youtubePlaylists, setYoutubePlaylists] = useState<PlaylistRef[]>([]);
  const [syncError, setSyncError] = useState(
    SYNC_ERRORS[new URLSearchParams(location.search).get('youtube') || ''] || '',
  );

  useEffect(() => {
    if (isNative) return;
    fetch('/api/youtube/playlists')
      .then(async (response) => {
        if (response.ok) setYoutubePlaylists(await response.json());
        else if (response.status !== 401) setSyncError('Could not load YouTube playlists.');
      })
      .catch(() => setSyncError('Could not load YouTube playlists.'));
  }, []);

  const [playlist, setPlaylist] = useState<PlaylistRef>();
  const [playlistTracks, setPlaylistTracks] = useState<Video[]>([]);
  const [playlistStatus, setPlaylistStatus] = useState('');

  useEffect(() => {
    if (!playlist) return;
    const request = new AbortController();
    setPlaylistTracks([]);
    setPlaylistStatus('Loading playlist…');
    fetch('/api/youtube/playlist-items?id=' + encodeURIComponent(playlist.id), {
      signal: request.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw Error(data.error);
        if (!request.signal.aborted) {
          setPlaylistTracks(data);
          setPlaylistStatus(data.length ? '' : 'No available videos in this playlist.');
        }
      })
      .catch((issue) => {
        if (!request.signal.aborted) setPlaylistStatus(issue.message || 'Could not load this playlist.');
      });
    return () => request.abort();
  }, [playlist]);

  /* ---------- search ---------- */

  const [matches, setMatches] = useState<Video[]>([]);
  const [searchStatus, setSearchStatus] = useState('');
  const [results, setResults] = useState<Video[]>([]);
  const [searchMessage, setSearchMessage] = useState('');
  const searchRequest = useRef(0);

  useEffect(
    () =>
      onNativeEvent<SearchEvent>('spotitube-search', ({ request, videos: found }) => {
        if (request !== searchRequest.current) return;
        const visible = (found || []).filter(allowedRecommendation);
        setMatches(visible);
        setSearchStatus(
          !found ? 'YouTube search failed. Try again.' : visible.length ? '' : 'No matching videos. Try All videos or review your blocked items in Settings.',
        );
      }),
    [],
  );

  /* ---------- radio ---------- */

  const [radioSeed, setRadioSeed] = useState<string | null>(null);
  const [radioLoading, setRadioLoading] = useState(false);
  const radioRequest = useRef(0);
  const radioSeeds = useRef<Set<string>>(new Set());
  const pendingAdvance = useRef(false);

  useEffect(
    () =>
      onNativeEvent<RadioEvent>('spotitube-radio', ({ request, videos: found }) => {
        if (request !== radioRequest.current) return;
        setRadioLoading(false);
        const incoming = Array.isArray(found) ? found.filter((item) => item && item.id && allowedRecommendation(item)) : [];
        if (!incoming.length) {
          pendingAdvance.current = false;
          setActionMessage('No more matching songs found. Radio settings are available in Settings.');
          return;
        }
        const fresh = incoming.map((item) => ({ ...entry(item), recommended: true }));
        setQueue((items) => {
          const seen = new Set(items.map((item) => item.video.id));
          const addable = fresh.filter((item) => !seen.has(item.video.id));
          if (isNative && addable.length) nativeEnqueue(addable);
          return addable.length ? [...items, ...addable] : items;
        });
      }),
    [],
  );

  function loadRadio(seed: Video) {
    if (radioSeeds.current.has(seed.id)) return;
    radioSeeds.current.add(seed.id);
    const request = ++radioRequest.current;
    setRadioLoading(true);
    requestRadio(seed, request, recommendations.current.musicRadio);
  }

  function startRadio(target: Video) {
    radioSeeds.current = new Set();
    pendingAdvance.current = false;
    setRadioSeed(target.id);
    playEntries([entry(target)], 0);
    loadRadio(target);
  }

  function stopRadio() {
    pendingAdvance.current = false;
    radioRequest.current++;
    radioSeeds.current.clear();
    setRadioSeed(null);
    setRadioLoading(false);
  }

  useEffect(() => {
    if (!radioSeed || !current) return;
    const index = queue.findIndex((item) => item.key === current.key);
    if (index < 0 || queue.length - 1 - index > 3) return;
    const last = queue[queue.length - 1];
    if (last) loadRadio(last.video);
  }, [queue, current, radioSeed]);

  useEffect(() => {
    if (!pendingAdvance.current || !current) return;
    const index = queue.findIndex((item) => item.key === current.key);
    if (index >= 0 && index + 1 < queue.length) {
      pendingAdvance.current = false;
      playEntries(queue, index + 1);
    }
  }, [queue, current]);

  useEffect(() => {
    if (isNative && !editableQueue) return;
    const index = queue.findIndex((item) => item.key === current?.key);
    const removed = queue.filter((item, offset) => offset > index && item.recommended && !allowedRecommendation(item.video));
    if (!removed.length) return;
    if (isNative && current) removed.forEach((item) => nativeEditQueue(item.key, 0));
    const keys = new Set(removed.map((item) => item.key));
    setQueue((items) => items.filter((item) => !keys.has(item.key)));
  }, [blockedVideos, blockedChannels, editableQueue, queue, current?.key]);

  const queueRef = useRef(queue);
  const currentRef = useRef(current);

  /* ---------- Supabase sync ---------- */

  const [syncEmail, setSyncEmail] = useState('');
  const [syncPassword, setSyncPassword] = useState('');
  const [syncSession, setSyncSession] = useState<Session | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [resume, setResume] = useState<ResumePosition | null>(null);
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const syncSessionRef = useRef<Session | null>(null);
  const resumeRef = useRef<ResumePosition | null>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timeRef.current = time;
  }, [time]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    syncSessionRef.current = syncSession;
  }, [syncSession]);

  useEffect(() => {
    let active = true;
    currentSession().then((session) => active && setSyncSession(session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setSyncSession(session);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    setSyncMessage('');
    if (!syncSession) {
      setSyncStatus('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setSyncStatus('Syncing…');
        const remote = await pullState(syncSession.user.id);
        if (cancelled) return;
        const localStampAt = localStamp() ? new Date(localStamp()).getTime() : 0;
        if (remote && new Date(remote.updatedAt).getTime() > localStampAt) {
          // Remote wins: restore whichever library is newer.
          like(remote.likes);
          remember(remote.history);
          setRecentVideos(remote.recent);
          setPlaylists(remote.playlists);
          rememberStamp(remote.updatedAt);
          setSyncStatus('Synced');
          if (remote.resume) setResume(remote.resume);
        } else if (remote || remote === null) {
          // Local is newer or remote is empty: push, don't lose local work.
          const stamp = await pushState(syncSession.user.id, {
            likes,
            history,
            recent: recentVideos,
            playlists,
            resume: resumeRef.current,
          });
          if (!cancelled) rememberStamp(stamp);
          setSyncStatus('Synced');
          if (remote?.resume) setResume(remote.resume);
        }
      } catch {
        if (!cancelled) setSyncStatus('Sync unavailable — library still works offline');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncSession?.user?.id]);

  async function pushNow(session: Session | null = syncSessionRef.current) {
    if (!session) return;
    try {
      const stamp = await pushState(session.user.id, {
        likes,
        history,
        recent: recentVideos,
        playlists,
        resume: resumeRef.current,
      });
      rememberStamp(stamp);
      setSyncStatus('Synced');
    } catch {
      setSyncStatus('Sync unavailable — library still works offline');
    }
  }

  // Debounce library changes into a single push.
  useEffect(() => {
    if (!syncSession) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => pushNow(), 2500);
    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [likes, history, recentVideos, playlists, syncSession]);

  // Keep the remote "resume position" fresh while listening.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!playingRef.current || !currentRef.current || !syncSessionRef.current) return;
      const v = currentRef.current.video;
      resumeRef.current = {
        id: v.id,
        title: v.title,
        author_name: v.author_name,
        thumbnail_url: v.thumbnail_url,
        time: Math.floor(timeRef.current),
        at: Date.now(),
      };
      pushNow(syncSessionRef.current);
    }, 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitSync(mode: 'signin' | 'signup') {
    const email = syncEmail.trim();
    if (!email || !syncPassword) return;
    setSyncBusy(true);
    setSyncMessage('');
    const failure =
      mode === 'signin' ? await signIn(email, syncPassword) : await signUp(email, syncPassword);
    setSyncBusy(false);
    if (failure) {
      setSyncMessage(failure);
      return;
    }
    if (mode === 'signup') setSyncMessage('Account created. Signed in and syncing.');
  }

  /* ---------- artist pages ---------- */

  const [artistData, setArtistData] = useState<ArtistInfo | null>(null);
  const [artistStatus, setArtistStatus] = useState('');
  const artistRequest = useRef(0);

  useEffect(
    () =>
      onNativeEvent<ArtistEvent>('spotitube-artist', ({ request, artist }) => {
        if (request !== artistRequest.current) return;
        setArtistData(artist);
        setArtistStatus(artist ? '' : 'Could not load this artist right now.');
      }),
    [],
  );

  function goToArtist(channelUrl?: string) {
    if (!channelUrl || !isNative) return;
    setArtistData(null);
    setArtistStatus('Loading channel…');
    navigate('Artist');
    const request = ++artistRequest.current;
    nativeArtist(channelUrl, request);
  }
  useEffect(() => {
    queueRef.current = queue;
    currentRef.current = current;
  });

  /**
   * Replace the queue and play position. Native owns playback state from here:
   * the bridge resolves the whole queue (offline files preferred) and hands
   * ExoPlayer a growing playlist so track-to-track is gapless.
   */
  function playEntries(items: Entry[], index: number, position = 0, context?: string) {
    if (!items.length) return;
    playlistContext.current = context ?? (page === 'My playlist' ? selectedListId ?? undefined : undefined);
    const selected = items[Math.max(0, Math.min(items.length - 1, index))];
    setQueue(items);
    setRecentVideos((recent) => [selected.video, ...recent.filter((v) => v.id !== selected.video.id)].slice(0, 20));
    select(selected);
    setTime(0);
    setDuration(0);
    setPlaying(false);
    setPlayerError('');
    remember((ids) => [selected.video.id, ...ids.filter((id) => id !== selected.video.id)].slice(0, 30));
    if (isNative) nativePlayQueue(items, items.indexOf(selected), position * 1000);
  }

  // Web-only single-item helper (native path goes through playEntries).
  function start(item: Entry) {
    if (isNative) {
      const index = queueRef.current.findIndex((row) => row.key === item.key);
      if (index >= 0) playEntries(queueRef.current, index);
      else playEntries([item], 0);
      return;
    }
    setRecentVideos((items) => [item.video, ...items.filter((v) => v.id !== item.video.id)].slice(0, 20));
    select(item);
    setTime(0);
    setDuration(0);
    setPlaying(false);
    setPlayerError('');
    remember((ids) => [item.video.id, ...ids.filter((id) => id !== item.video.id)].slice(0, 30));
  }

  function step(direction: number, automatic = false) {
    if (isNative) {
      if (!automatic) nativeControl(direction > 0 ? 'next' : 'prev');
      return;
    }
    if (!current) return;
    if (automatic && repeat === 2) {
      player.current?.seekTo(0, true);
      player.current?.playVideo();
      return;
    }
    const index = queue.findIndex((item) => item.key === current.key);
    const next =
      queue[index + direction] ||
      (repeat === 1 && queue.length ? queue[(index + direction + queue.length) % queue.length] : undefined);
    if (next?.key === current.key) {
      player.current?.seekTo(0, true);
      player.current?.playVideo();
    } else if (next) start(next);
    else if (automatic && radioSeed) {
      const last = queue[queue.length - 1];
      if (last) {
        pendingAdvance.current = true;
        loadRadio(last.video);
      }
    }
  }

  useEffect(() => {
    if (isNative) nativeSetRepeat(repeat);
  }, [repeat]);

  ended.current = () => step(1, true);

  useEffect(() => {
    if (!current) return;
    if (isNative) {
      player.current = {
        playVideo: () => nativeControl('play'),
        pauseVideo: () => nativeControl('pause'),
        seekTo: (seconds: number) => nativeControl('seek', seconds),
        setVolume: (value: number) => nativeControl('volume', value),
      };
      setPlaying(false);
      setTime(0);
      setDuration(0);
      setPlayerError('');
      setNativeReady(false);
      // playEntries already handed the queue to the bridge; nothing to load here.

      const poll = setInterval(() => {
        const state = nativeState();
        if (!state) return;
        // Follow the native playlist: track changes on gapless auto-advance.
        if (state.key && currentRef.current?.key !== state.key) {
          const tracked = queueRef.current.find((row) => row.key === state.key);
          if (tracked) {
            setRecentVideos((items) => [
              tracked.video,
              ...items.filter((v) => v.id !== tracked.video.id),
            ].slice(0, 20));
            select(tracked);
            setPlayerError('');
            remember((ids) => [
              tracked.video.id,
              ...ids.filter((id) => id !== tracked.video.id),
            ].slice(0, 30));
          }
        }
        setNativeReady(!state.loading && Boolean(state.duration) && !state.error);
        setPlaying(Boolean(state.playing));
        setTime(state.time || 0);
        setDuration(state.duration || 0);
        setEditableQueue(Boolean(state.editableQueue));
        setBuffered(state.buffered ?? 0);
        setPlayerError(state.error || (state.preparing ? 'Preparing song…' : state.loading
          ? (navigator.onLine ? 'Buffering…' : 'Waiting for internet…') : ''));
      }, 350);

      return () => {
        clearInterval(poll);
        player.current = null;
      };
    }

    if (audioMode) {
      const element = audio.current;
      if (!element) return;
      const request = new AbortController();
      const update = () => {
        setTime(element.currentTime);
        setDuration(Number.isFinite(element.duration) ? element.duration : 0);
      };
      const sync = () => setPlaying(!element.paused);
      const advance = () => ended.current();
      const failed = () => setPlayerError('This audio stream could not play. Try Video mode.');
      const listeners: Record<string, () => void> = {
        timeupdate: update,
        durationchange: update,
        play: sync,
        pause: sync,
        ended: advance,
        error: failed,
      };
      Object.entries(listeners).forEach(([event, listener]) => element.addEventListener(event, listener));
      element.volume = volume / 100;
      player.current = {
        playVideo: () => element.play().catch(failed),
        pauseVideo: () => element.pause(),
        seekTo: (seconds: number) => {
          element.currentTime = seconds;
        },
        setVolume: (value: number) => {
          element.volume = value / 100;
        },
      };
      setPlayerError('');
      setTime(0);
      setDuration(0);
      setPlaying(false);
      fetchAudioStream(current.video.id)
        .then(async (stream) => {
          if (request.signal.aborted) return;
          element.src = stream;
          await element.play().catch(() => {});
        })
        .catch((issue) => {
          if (!request.signal.aborted) setPlayerError(issue.message);
        });
      return () => {
        request.abort();
        Object.entries(listeners).forEach(([event, listener]) => element.removeEventListener(event, listener));
        element.pause();
        element.removeAttribute('src');
        element.load();
        player.current = null;
      };
    }

    const api = window as any;
    let disposed = false;
    let instance: any;
    const connect = () => {
      if (disposed || !frame.current || player.current) return;
      instance = player.current = new api.YT.Player(frame.current, {
        events: {
          onReady: ({ target }: any) => {
            target.setVolume(volume);
            if (!document.hidden) target.playVideo();
          },
          onStateChange: ({ data, target }: any) => {
            setPlaying(data === 1);
            if (data === 1 && document.hidden) target.pauseVideo();
            if (data === 0 && !document.hidden) ended.current();
          },
          onError: ({ data }: { data: number }) => {
            setPlaying(false);
            setPlayerError(
              data === 153
                ? 'YouTube could not identify Spotitube. Open the app in Chrome or Edge and try again.'
                : data === 101 || data === 150
                  ? 'The uploader does not allow this video to play in embedded players.'
                  : data === 100
                    ? 'This video is private or has been removed.'
                    : 'YouTube could not play this video (error ' + data + ').',
            );
          },
          onAutoplayBlocked: () => setPlaying(false),
        },
      });
    };
    if (api.YT?.Player) connect();
    else {
      api.onYouTubeIframeAPIReady = connect;
      if (!document.querySelector('script[data-youtube]')) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.dataset.youtube = '';
        document.head.append(script);
      }
    }
    const ticker = setInterval(() => {
      const instance = player.current;
      if (instance?.getCurrentTime) {
        setTime(instance.getCurrentTime() || 0);
        setDuration(instance.getDuration() || 0);
      }
    }, 350);
    const pause = () => {
      if (document.hidden) player.current?.pauseVideo?.();
    };
    document.addEventListener('visibilitychange', pause);
    return () => {
      disposed = true;
      clearInterval(ticker);
      document.removeEventListener('visibilitychange', pause);
      instance?.destroy?.();
      player.current = null;
    };
  }, [current?.key, audioMode]);

  function playPlaylist(list: Video[], random: boolean) {
    if (radioSeed) stopRadio();
    const items = (random ? shuffled(list) : list).map(entry);
    if (!items.length) return;
    toggleShuffle(random);
    playEntries(items, 0);
  }

  function changeShuffle() {
    if (!shuffle) {
      const index = queue.findIndex((item) => item.key === current?.key);
      const ordered = [
        ...queue.slice(0, Math.max(0, index) + 1),
        ...shuffled(queue.slice(Math.max(0, index) + 1)),
      ];
      setQueue(ordered);
      if (isNative && current) nativePlayQueue(ordered, Math.max(0, index), time * 1000);
    }
    toggleShuffle(!shuffle);
  }

  function playVideo(item: Video, list: Video[], position?: number) {
    if (radioSeed) stopRadio();
    const items = list.map(entry);
    const selected =
      (position === undefined ? undefined : items[position]) ??
      items.find((row) => row.video.id === item.id) ??
      entry(item);
    const ordered = shuffle
      ? [selected, ...shuffled(items.filter((row) => row.key !== selected.key))]
      : items.length
        ? items
        : [selected];
    playEntries(ordered, Math.max(0, ordered.indexOf(selected)));
  }

  function favorite(target: Video) {
    save((list) => (list.some((item) => item.id === target.id) ? list : [target, ...list]));
    like((ids) =>
      ids.includes(target.id) ? ids.filter((value) => value !== target.id) : [target.id, ...ids],
    );
  }

  function saveVideo(target: Video) {
    if (!videos.some((item) => item.id === target.id)) {
      setAdded((items) => ({ ...items, [target.id]: Date.now() }));
    }
    save((items) => (items.some((item) => item.id === target.id) ? items : [target, ...items]));
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    fail('');
    loading(true);
    try {
      const link = new URL(url.trim());
      const id =
        link.hostname === 'youtu.be'
          ? link.pathname.split('/')[1]
          : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(link.hostname)
            ? link.searchParams.get('v') || (link.pathname.startsWith('/shorts/') ? link.pathname.split('/')[2] : null)
            : null;
      if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw Error();
      const item = await fetchMetadata(id);
      const list = [item, ...videos.filter((v) => v.id !== id)];
      save(list);
      playVideo(item, list);
      setUrl('');
      navigate('Home');
    } catch (issue) {
      fail(
        issue instanceof Error && issue.message.startsWith('YouTube')
          ? issue.message
          : 'Paste a valid YouTube video link.',
      );
    } finally {
      loading(false);
    }
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    showSearchResults();
    if (!isNative || !query.trim()) return;
    setMatches([]);
    setSearchStatus('Searching YouTube…');
    nativeSearch(query.trim(), ++searchRequest.current, musicSearch);
  }

  function findVideos(event: React.FormEvent) {
    event.preventDefault();
    showSearchResults();
    if (!query.trim()) return;
    setResults([]);
    setSearchMessage('Searching YouTube…');
    webSearch(query.trim())
      .then((found) => {
        setResults(found);
        setSearchMessage(found.length ? '' : 'No results found.');
      })
      .catch(() => setSearchMessage('YouTube search is unavailable.'));
  }

  /* ---------- YouTube playlist import (Android) ---------- */

  const [playlistUrl, setPlaylistUrl] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(
    () =>
      onNativeEvent<{ id: string; playlist: { name: string; videos: Video[] } | null }>(
        'spotitube-playlist',
        ({ id, playlist: imported }) => {
          setImporting(false);
          if (!imported) {
            setImportStatus('Could not import this playlist. Check that it is public or unlisted.');
            return;
          }
          save((items) =>
            Array.from(new Map([...items, ...imported.videos].map((v) => [v.id, v])).values()),
          );
          // Fresh read beats the mount-time closure: pick (or create) the list to open.
          const storedForTarget = read<Playlist[]>(KEYS.playlists, []);
          const importTargetId =
            storedForTarget.find((item) => item.source === id)?.id ?? uuid();
          const ids = imported.videos.map((v) => v.id);
          const previous = storedForTarget.find((item) => item.id === importTargetId);
          const changes = new Map<string, number>();
          for (const id of previous?.ids ?? []) changes.set(id, (changes.get(id) ?? 0) - 1);
          for (const id of ids) changes.set(id, (changes.get(id) ?? 0) + 1);
          const added = [...changes.values()].reduce((sum, n) => sum + Math.max(n, 0), 0);
          const removed = [...changes.values()].reduce((sum, n) => sum + Math.max(-n, 0), 0);
          const refreshedAt = Date.now();
          setPlaylists((items) => {
            const existing = items.find((item) => item.source === id);
            if (existing) {
              return items.map((item) =>
                item.source === id ? withPlaylistIds({ ...item, name: imported.name, refreshedAt }, ids, refreshedAt) : item,
              );
            }
            return [...items, withPlaylistIds({ id: importTargetId, name: imported.name, ids: [], source: id, refreshedAt }, ids, refreshedAt)];
          });
          if (!previous) setSelectedListId(importTargetId);
          setPlaylistUrl('');
          setImportStatus(`${imported.name}: ${added} added, ${removed} removed.`);
        },
      ),
    [],
  );

  function syncPlaylist(id: string) {
    if (importing) return;
    setImporting(true);
    setImportStatus('Loading playlist…');
    nativeImportPlaylist(id);
  }

  useEffect(() => {
    if (isNative && page === 'My playlist' && selectedList?.source &&
        Date.now() - (selectedList.refreshedAt ?? 0) > 30 * 60_000) {
      syncPlaylist(selectedList.source);
    }
  }, [page, selectedListId]);

  function importPlaylist(event: React.FormEvent) {
    event.preventDefault();
    try {
      const link = new URL(playlistUrl.trim());
      const id = link.searchParams.get('list');
      if (
        link.protocol !== 'https:' ||
        !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(
          link.hostname,
        ) ||
        !id ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(id)
      )
        throw Error();
      syncPlaylist(id);
    } catch {
      setImportStatus('Paste a YouTube link that includes a playlist.');
    }
  }

  /* ---------- derived lists ---------- */

  const listRows = (selectedList ? playlistEntries(selectedList) : []).flatMap((row, offset) => {
    const video = videos.find((item) => item.id === row.videoId);
    return video ? [{ video, offset, row }] : [];
  }).filter(({ video }) =>
    (video.title + ' ' + video.author_name).toLowerCase().includes(listQuery.trim().toLowerCase()),
  );
  if (listSort === 'title' || listSort === 'artist') {
    const field = listSort === 'title' ? 'title' : 'author_name';
    listRows.sort((a, b) => a.video[field].localeCompare(b.video[field]));
  }
  if (listSort === 'added') listRows.sort((a, b) => (b.row.addedAt ?? 0) - (a.row.addedAt ?? 0));
  const listTracks = listRows.map(({ video }) => video);
  function movePlaylistRow(from: number, to: number) {
    if (from === to || listQuery || listSort !== 'manual') return;
    setPlaylists((items) => items.map((item) => {
      if (item.id !== selectedListId || item.source || to < 0 || to >= item.ids.length) return item;
      const entries = [...playlistEntries(item)];
      entries.splice(to, 0, ...entries.splice(from, 1));
      return { ...item, entries, ids: entries.map((row) => row.videoId) };
    }));
  }

  function dragHandle(group: string, index: number, move: (from: number, to: number) => void) {
    return <button type="button" className="reorder-handle" aria-label="Drag to reorder"
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const panel = event.currentTarget.closest('.content');
        if (!panel) return;
        const bounds = panel.getBoundingClientRect();
        if (event.clientY < bounds.top + 56) panel.scrollBy(0, -20);
        if (event.clientY > bounds.bottom - 56) panel.scrollBy(0, 20);
      }}
      onPointerUp={(event) => {
        const row = document.elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-reorder-group]');
        if (row?.dataset.reorderGroup !== group) return;
        const target = Number(row.dataset.reorderIndex);
        if (Number.isInteger(target)) move(index, target);
      }}>⠿</button>;
  }
  function removePlaylistRows(offsets: number[]) {
    const selected = new Set(offsets);
    setPlaylists((items) => items.map((item) =>
      item.id === selectedListId && !item.source
        ? { ...item, ids: item.ids.filter((_, offset) => !selected.has(offset)),
            entries: playlistEntries(item).filter((_, offset) => !selected.has(offset)) }
        : item,
    ));
  }
  const playlistQueue = page === 'Playlist' ? playlistTracks : page === 'My playlist' ? listTracks : [];
  const shown =
    page === 'My playlist'
      ? listTracks
      : isNative && page === 'Search'
        ? matches
        : page === 'Liked videos'
          ? videos.filter((v) => likes.includes(v.id))
          : videos.filter(
              (v) =>
                page !== 'Search' ||
                (v.title + ' ' + v.author_name).toLowerCase().includes(query.trim().toLowerCase()),
            );

  const lyrics = useLyrics(video ? { ...video, duration: video.duration || duration || undefined } : undefined, lyricsAttempt);
  const seek = (seconds: number) => {
    setTime(seconds);
    player.current?.seekTo(seconds);
  };

  const icon = (
    label: string,
    glyph: string,
    action: () => void,
    active?: boolean,
    disabled?: boolean,
  ) => (
    <button
      type="button"
      className={'icon ' + (active ? 'active' : '')}
      title={label}
      aria-label={label}
      onClick={action}
      disabled={disabled}
    >
      {glyph}
    </button>
  );

  function toggleDownload(item: Video) {
    if (!isNative) return;
    if (downloads[item.id]) {
      nativeDeleteDownload(item.id);
      return;
    }
    nativeDownload(item);
    setActionMessage('Downloading ' + item.title);
  }

  const downloadState = (id: string): 'idle' | 'downloading' | 'downloaded' =>
    downloads[id] ? 'downloaded' : downloading[id] !== undefined ? 'downloading' : 'idle';

  function pageRow(item: Video, index: number, list: Video[], inPlaylist = false) {
    return (
      <TrackRow
        key={item.id + index}
        video={item}
        index={index}
        isPlaying={video?.id === item.id}
        liked={likes.includes(item.id)}
        saved={videos.some((saved) => saved.id === item.id)}
        hasPlaylists={true}
        inPlaylist={inPlaylist}
        downloadState={isNative ? downloadState(item.id) : undefined}
        onDownload={isNative ? () => toggleDownload(item) : undefined}
        onPlay={() => playVideo(item, list, index)}
        onLike={() => favorite(item)}
        onSave={() => {
          saveVideo(item);
          setActionMessage('Saved to your library');
        }}
        onAddToPlaylist={() => {
          let target = playlists.find((playlist) => !playlist.source);
          if (!target) {
            target = { id: uuid(), name: 'My playlist', ids: [] };
            setPlaylists((items) => [...items, target!]);
          }
          setDestination(target.id);
          setPick(item);
        }}
        onRemove={
          inPlaylist
            ? () => removePlaylistRows([listRows[index].offset])
            : undefined
        }
        onQueue={() => {
          const row = entry(item);
          setQueue((items) => [...items, row]);
          if (isNative && current) nativeEnqueue([row]);
          setActionMessage('Added to queue');
        }}
        onRadio={() => startRadio(item)}
        onBlock={() => setBlockTarget(item)}
      />
    );
  }

  return (
    <>
      {blockTarget && <div className="playlist-dialog-backdrop" onClick={() => setBlockTarget(undefined)}>
        <div className="playlist-dialog" role="dialog" aria-modal="true" aria-label="Recommendation preferences" onClick={(event) => event.stopPropagation()}>
          <strong>{blockTarget.title}</strong>
          <p>Hide from search and future radio suggestions. Saved playlists stay editable.</p>
          <button className="secondary" onClick={() => {
            setBlockedVideos((items) => ({ ...items, [blockTarget.id]: blockTarget.title }));
            setMatches((items) => items.filter((item) => item.id !== blockTarget.id));
            setBlockTarget(undefined); setActionMessage('Video blocked from recommendations');
          }}>Don't recommend this video</button>
          <button className="secondary" disabled={!channelKey(blockTarget)} onClick={() => {
            const key = channelKey(blockTarget);
            setBlockedChannels((items) => ({ ...items, [key]: blockTarget.author_name }));
            setMatches((items) => items.filter((item) => channelKey(item) !== key));
            setBlockTarget(undefined); setActionMessage('Channel blocked from recommendations');
          }}>Don't recommend this channel</button>
          <button onClick={() => setBlockTarget(undefined)}>Cancel</button>
        </div>
      </div>}
      {actionMessage && <div className="action-toast" role="status">{actionMessage}</div>}
      <header>
        <button className="brand" onClick={() => navigate('Home')}>
          <span>◉</span> Spotitube
        </button>
        {isNative && downloadJobs.some((job) => ['queued','preparing','downloading'].includes(job.status)) &&
          <button onClick={() => navigate('Offline')}>Downloads ({downloadJobs.filter((job) =>
            ['queued','preparing','downloading'].includes(job.status)).length})</button>}
        <button className="secondary" onClick={() => navigate('Settings')}>Settings</button>
        <nav aria-label="Main navigation">
          {['Home', 'Library', 'Liked videos', 'Queue', 'Offline'].map((item) => (
            <button
              key={item}
              className={page === item ? 'selected' : ''}
              aria-current={page === item ? 'page' : undefined}
              onClick={() => {
                navigate(item);
                if (item === 'Home') requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
              }}
            >
              {item}
            </button>
          ))}
        </nav>
        <form className="search-form" onSubmit={submitSearch}>
          {isNative && <select aria-label="Search catalog" value={musicSearch ? 'music' : 'all'} onChange={(event) => {
            setMusicSearch(event.target.value === 'music'); searchRequest.current++; setMatches([]); setSearchStatus('');
          }}><option value="music">Music</option><option value="all">All videos</option></select>}
          <input
            aria-label={isNative ? 'Search YouTube' : 'Search saved videos'}
            placeholder={isNative ? 'Search YouTube' : 'Search saved videos'}
            maxLength={120}
            value={query}
            onFocus={() => navigate('Search')}
            onChange={(event) => search(event.target.value)}
          />
          {isNative && (
            <button type="submit" aria-label="Search YouTube">
              Search
            </button>
          )}
        </form>
      </header>
      <main className={(expanded && video ? 'expanded ' : '') + (page === 'Home' ? 'home-page' : '')}>
        <aside className="panel library">
          <h2>Your library</h2>
          {!isNative && <a href="/auth/google">Connect YouTube</a>}
          {syncError && <p role="alert">{syncError}</p>}
          <button className="library-link sync-link" onClick={() => navigate('Sync')}>
            <i>⤓</i>
            <span>
              Sync
              <small>{syncSession ? syncStatus || 'Signed in' : 'Sync your library'}</small>
            </span>
          </button>
          {youtubePlaylists.map((item) => (
            <button
              key={item.id}
              className="library-link playlist-link"
              aria-current={page === 'Playlist' && playlist?.id === item.id ? 'page' : undefined}
              onClick={() => {
                setPlaylist(item);
                navigate('Playlist');
              }}
            >
              <i>♫</i>
              <span>
                {item.title}
                <small>YouTube playlist</small>
              </span>
            </button>
          ))}
          <button className="library-link" onClick={() => navigate('Liked videos')}>
            <i>♥</i>
            <span>
              Liked videos
              <small>{likes.length} saved</small>
            </span>
          </button>
          {videos.map((item) => (
            <button key={item.id} className="library-link" onClick={() => playVideo(item, videos)}>
              <img src={item.thumbnail_url} alt="" />
              <span>
                {item.title}
                <small>{item.author_name}</small>
              </span>
            </button>
          ))}
        </aside>
        <section className={'panel content' + (page === 'Search' ? ' search-page' : '') + (['Queue', 'Playlist', 'My playlist', 'Liked videos'].includes(page) ? ' outlined-tracks' : '')}>
          {page === 'Home' && (
            <div className="hero">
              <span className="eyebrow">YOUR YOUTUBE MUSIC LIBRARY</span>
              <h1>Music for your day</h1>
              <p>Bring a YouTube video into your library and press play.</p>
              <form onSubmit={add}>
                <input
                  aria-label="YouTube link"
                  placeholder="Paste a YouTube link"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  required
                />
                <button className="primary" disabled={busy}>
                  {busy ? 'Adding…' : 'Add video'}
                </button>
              </form>
              {error && <p role="alert">{error}</p>}
            </div>
          )}
          {(page === 'Library' || page === 'Home') && (
            <div className="playlist-browser">
              <h2>Your playlists</h2>
              {playlists.length === 0 && (
                <div className="playlist-empty">
                  <p>
                    Your favorites, in good company.
                    <br />
                    Create a playlist to make it yours.
                  </p>
                  {page === 'Home' && (
                    <button className="secondary" onClick={() => navigate('Library')}>
                      Create playlist
                    </button>
                  )}
                </div>
              )}
              {page === 'Library' && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!name.trim()) return;
                    const id = uuid();
                    setPlaylists([...playlists, { id, name: name.trim(), ids: [] }]);
                    setSelectedListId(id);
                    setName('');
                    navigate('My playlist');
                  }}
                >
                  <input
                    aria-label="Playlist name"
                    placeholder="Playlist name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <button className="primary">Create playlist</button>
                </form>
              )}
              {playlists.map((item) => (
                <button
                  key={item.id}
                  className="library-link"
                  onClick={() => {
                    setSelectedListId(item.id);
                    navigate('My playlist');
                  }}
                >
                  <i>♫</i>
                  <span>
                    {item.name}
                    <small>{item.ids.length} videos</small>
                  </span>
                </button>
              ))}
            </div>
          )}
          {isNative && page === 'Library' && (
            <form onSubmit={importPlaylist}>
              <input
                aria-label="YouTube playlist link"
                placeholder="Paste YouTube playlist link"
                value={playlistUrl}
                onChange={(event) => setPlaylistUrl(event.target.value)}
              />
              <button className="primary" disabled={importing}>
                Import playlist
              </button>
            </form>
          )}
          {isNative && page === 'My playlist' && selectedList?.source && (
            <button className="primary" disabled={importing} onClick={() => syncPlaylist(selectedList.source!)}>
              Refresh from YouTube
            </button>
          )}
          {isNative && page === 'My playlist' && selectedList &&
            <button className="secondary" onClick={() => {
              listTracks.forEach(nativeDownload); setActionMessage('Playlist added to downloads');
            }}>Download playlist</button>}
          {page === 'My playlist' && selectedList && (
            <div className="playlist-actions">
              {selectedList.source && <small>Linked to YouTube · {selectedList.refreshedAt
                ? 'Refreshed ' + new Date(selectedList.refreshedAt).toLocaleString()
                : 'Refresh date unknown'}</small>}
              <input aria-label="Search playlist" placeholder="Search playlist" value={listQuery}
                onChange={(event) => setListQuery(event.target.value)} />
              <select aria-label="Playlist order" value={listSort} onChange={(event) => setListSort(event.target.value)}>
                <option value="manual">Playlist order</option>
                <option value="title">Title</option>
                <option value="artist">Artist</option>
                <option value="added">Date added</option>
              </select>
              {listSelection.length > 0 && (
                <>
                  {isNative && <button className="secondary" onClick={() => {
                    listRows.filter(({ offset }) => listSelection.includes(offset)).forEach(({ video }) => nativeDownload(video));
                    setActionMessage('Selected songs added to downloads');
                  }}>Download selected</button>}
                  <select aria-label="Add selected to playlist" value="" onChange={(event) => {
                    const destinationId = event.target.value;
                    if (!destinationId) return;
                    const ids = listRows.filter(({ offset }) => listSelection.includes(offset)).map(({ video }) => video.id);
                    setPlaylists((items) => items.map((item) => item.id === destinationId && !item.source
                      ? withPlaylistIds(item, [...item.ids, ...ids], Date.now()) : item));
                    setListSelection([]);
                  }}>
                    <option value="">Add {listSelection.length} selected to…</option>
                    {playlists.filter((item) => !item.source && item.id !== selectedListId).map((item) =>
                      <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  {!selectedList.source && <button className="secondary" onClick={() => {
                    if (window.confirm('Remove ' + listSelection.length + ' selected entries?')) removePlaylistRows(listSelection);
                  }}>Remove selected</button>}
                </>
              )}
              {selectedList.source ? (
                <button className="secondary" onClick={() => {
                  const id = uuid();
                  setPlaylists((items) => [...items, { id, name: selectedList.name + ' (copy)', ids: [...selectedList.ids] }]);
                  setSelectedListId(id);
                }}>Make editable copy</button>
              ) : (
                <button className="secondary" onClick={() => {
                  const ids = [...new Set(selectedList.ids)];
                  const count = selectedList.ids.length - ids.length;
                  if (count && window.confirm('Remove ' + count + ' duplicate entries?')) {
                    setPlaylists((items) => items.map((item) => item.id === selectedList.id ? withPlaylistIds(item, ids) : item));
                  }
                }} disabled={new Set(selectedList.ids).size === selectedList.ids.length}>Remove duplicates</button>
              )}
            </div>
          )}
          {isNative && (page === 'Library' || page === 'My playlist') && importStatus && (
            <p role="status">{importStatus}</p>
          )}
          {isNative && page === 'Offline' && <section className="download-jobs">
            <h2>Downloading</h2>
            {downloadJobs.length === 0 && <p>No downloads in progress.</p>}
            {downloadJobs.map((job) => <div className="download-job" key={job.id}>
              <img src={job.thumbnail_url} alt="" />
              <div><strong>{job.title}</strong><small>{job.author_name}</small>
                <p role="status">{job.status} · {(job.received / 1048576).toFixed(1)} MB
                  {job.total > 0 && <> / {(job.total / 1048576).toFixed(1)} MB · {Math.floor(job.received / job.total * 100)}%</>}</p>
                <progress max={job.total > 0 ? job.total : 1} value={job.total > 0 ? job.received : undefined} />
              </div>
              {['queued','preparing','downloading'].includes(job.status)
                ? <button onClick={() => nativeCancelDownload(job.id)}>Cancel</button>
                : ['failed','canceled'].includes(job.status)
                  ? <button onClick={() => nativeRetryDownload(job.id)}>Retry</button> : null}
            </div>)}
            </section>}
          {pick && (
            <div className="playlist-dialog-backdrop" onClick={() => setPick(undefined)}>
            <form role="dialog" aria-modal="true" aria-label="Add to playlist" className="playlist-dialog"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                if (!playlists.some((item) => item.id === destination && !item.source)) return;
                saveVideo(pick);
                setPlaylists((items) =>
                  items.map((item) =>
                    item.id === destination && !item.source && !item.ids.includes(pick.id)
                      ? withPlaylistIds(item, [...item.ids, pick.id], Date.now())
                      : item,
                  ),
                );
                setPick(undefined);
                setActionMessage('Added to playlist');
              }}
            >
              <label>
                Add to playlist{' '}
                <select value={destination} onChange={(event) => setDestination(event.target.value)}>
                  {playlists.filter((item) => !item.source).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary">Add</button>
              <button type="button" onClick={() => setPick(undefined)}>
                Cancel
              </button>
            </form>
            </div>
          )}
          {page === 'Library' && youtubePlaylists.length > 0 && (
            <div className="playlist-browser">
              <h2>YouTube playlists</h2>
              {youtubePlaylists.map((item) => (
                <button
                  key={item.id}
                  className="library-link playlist-link"
                  onClick={() => {
                    setPlaylist(item);
                    navigate('Playlist');
                  }}
                >
                  <i>♫</i>
                  <span>
                    {item.title}
                    <small>YouTube playlist</small>
                  </span>
                </button>
              ))}
            </div>
          )}
          {page === 'Home' && resume && !video && (
            <div className="resume-card">
              <img src={resume.thumbnail_url} alt="" />
              <div className="resume-copy">
                <strong>Continue listening</strong>
                <small>
                  {resume.title} — {resume.author_name} · {clock(resume.time)} in
                </small>
              </div>
              <button
                className="primary"
                onClick={() => {
                  const item = {
                    id: resume.id,
                    title: resume.title,
                    author_name: resume.author_name,
                    thumbnail_url: resume.thumbnail_url,
                  };
                  playVideo(item, [item]);
                  setResume(null);
                  window.setTimeout(() => seek(resume.time), 1500);
                }}
              >
                Resume
              </button>
              <button className="resume-dismiss" aria-label="Dismiss" onClick={() => setResume(null)}>
                ×
              </button>
            </div>
          )}
          {isNative && page === 'Home' && playlists.some((item) =>
            item.ids.includes(resumeLists[item.id]?.videoId)) && (
            <section>
              <h2>Continue your playlists</h2>
              {playlists.filter((item) => item.ids.includes(resumeLists[item.id]?.videoId)).map((item) => (
                <button className="secondary" key={item.id} onClick={() => {
                  const resume = resumeLists[item.id];
                  const rows = item.ids.flatMap((id) => {
                    const track = videos.find((video) => video.id === id);
                    return track ? [entry(track)] : [];
                  });
                  const index = rows.findIndex((row) => row.video.id === resume.videoId);
                  if (index >= 0) playEntries(rows, index, resume.seconds, item.id);
                }}>Continue {item.name}</button>
              ))}
            </section>
          )}
          {page === 'Home' && [
            { title: 'Most played in the last 30 days', items: [...topTracks.values()].sort((a, b) => b.count - a.count).map(({ video }) => video) },
            { title: 'Recently added', items: videos.filter((item) => added[item.id]).sort((a, b) => added[b.id] - added[a.id]) },
          ].filter(({ items }) => items.length).map(({ title, items }) => (
            <section key={title}>
              <h2>{title}</h2>
              {items.slice(0, 5).map((item, index) => pageRow(item, index, items))}
            </section>
          ))}
          {page === 'Home' && recentVideos.length > 0 && (
            <>
              <h2>Recently played</h2>
              <div className="cards">
                {recentVideos.slice(0, 5).map((item) => (
                  <button key={item.id} onClick={() => playVideo(item, recentVideos)}>
                    <img src={item.thumbnail_url} alt="" />
                    <strong>{item.title}</strong>
                    <small>{item.author_name}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          <h2 ref={page === 'Search' ? searchResultsHeading : undefined} className={page === 'Search' ? 'search-results-heading' : undefined}>
            {page === 'My playlist'
              ? selectedList?.name
              : page === 'Playlist'
                ? playlist?.title
                : page === 'Home'
                  ? 'Saved videos'
                  : page === 'Search'
                    ? 'Search results'
                    : page === 'Queue'
                      ? 'Play queue'
                      : page === 'Offline'
                        ? 'Downloaded'
                        : page === 'Artist'
                          ? artistData?.name || 'Artist'
                          : page === 'Sync'
                            ? 'Sync'
                            : page}
          </h2>
          {playlistQueue.length > 0 && (
            <div className="playlist-actions">
              <button className="primary" onClick={() => playPlaylist(playlistQueue, false)}>
                ▶ Play all
              </button>
              <button className="secondary" onClick={() => playPlaylist(playlistQueue, true)}>
                ⤨ Shuffle play
              </button>
            </div>
          )}
          {page === 'Queue' && radioSeed && (
            <div className="radio-note">
              <span>
                ♾ Radio is on{radioLoading ? ' — loading more…' : ''}
              </span>
              <button type="button" className="secondary" onClick={stopRadio}>
                Stop radio
              </button>
            </div>
          )}
          {page === 'Playlist' ? (
            playlistStatus ? (
              <p className="empty" role="status">
                {playlistStatus}
              </p>
            ) : (
              playlistTracks.map((item, index) => pageRow(item, index, playlistTracks))
            )
          ) : page === 'Queue' ? (
            queue.length ? (
              queue.map((item, index) => (
                <div
                  className={'track' + (item.key === current?.key ? ' is-playing' : '')}
                  key={item.key}
                  data-reorder-group="queue"
                  data-reorder-index={index}
                >
                  <button className="track-play" onClick={() => playEntries(queue, index)}>
                    <span className="index">{item.key === current?.key ? '♪' : index + 1}</span>
                    <img src={item.video.thumbnail_url} alt="" />
                    <span className="copy">
                      <strong>{item.video.title}</strong>
                      <small>{item.video.author_name}</small>
                    </span>
                  </button>
                  <div className="track-actions">
                  {editableQueue && index > queue.findIndex((row) => row.key === current?.key) &&
                    dragHandle('queue', index, (from, to) => {
                      if (from === to || to <= queue.findIndex((row) => row.key === current?.key)) return;
                      const ordered = [...queue];
                      ordered.splice(to, 0, ...ordered.splice(from, 1));
                      if (isNative && current) nativeEditQueue(item.key, to - from);
                      setQueue(ordered);
                    })}
                  {[-1, 1].map((direction) => (
                    <button key={direction} aria-label={direction < 0 ? 'Move up' : 'Move down'}
                      disabled={!editableQueue || index <= queue.findIndex((row) => row.key === current?.key)
                        || index + direction <= queue.findIndex((row) => row.key === current?.key)
                        || index + direction < 0 || index + direction >= queue.length}
                      onClick={() => {
                        const ordered = [...queue];
                        ordered.splice(index + direction, 0, ...ordered.splice(index, 1));
                        if (isNative && current) nativeEditQueue(item.key, direction);
                        setQueue(ordered);
                      }}>{direction < 0 ? '↑' : '↓'}</button>
                  ))}
                  {icon(
                    'Remove from queue',
                    '×',
                    () => {
                      if (isNative && current) nativeEditQueue(item.key, 0);
                      setQueue((list) => list.filter((row) => row.key !== item.key));
                    },
                    false,
                    !editableQueue || index <= queue.findIndex((row) => row.key === current?.key),
                  )}
                  </div>
                </div>
              ))
            ) : (
              <p className="empty">Play a track or add one to the queue.</p>
            )
          ) : page === 'Settings' ? (
            <section className="settings-page">
              <h3>Music and recommendations</h3>
              <label className="setting-row"><span>Search catalog<small>Use All videos for obscure uploads, remixes or non-music content.</small></span>
                <select value={musicSearch ? 'music' : 'all'} onChange={(event) => {
                  setMusicSearch(event.target.value === 'music'); searchRequest.current++; setMatches([]); setSearchStatus('');
                }}><option value="music">Music only</option><option value="all">All videos</option></select>
              </label>
              <label className="setting-row"><span>Music-only radio<small>Uses song-catalog results from the seed artist. Turn off to use ordinary related videos.</small></span>
                <input type="checkbox" checked={musicRadio} onChange={(event) => {
                  setMusicRadio(event.target.checked); stopRadio();
                }} />
              </label>
              <h3>Playback</h3>
              <label className="setting-row"><span>Normalize audio<small>Keep loudness more consistent between songs.</small></span>
                <input type="checkbox" checked={normalize} onChange={(event) => setNormalize(event.target.checked)} />
              </label>
              <label className="setting-row"><span>Repeat</span><select value={repeat} onChange={(event) => setRepeat(+event.target.value)}>
                <option value={0}>Off</option><option value={1}>Queue</option><option value={2}>Song</option>
              </select></label>
              <label className="setting-row"><span>Volume and boost · {volume}%</span><input type="range" min="0" max={isNative ? 300 : 100}
                value={volume} onChange={(event) => {
                  const value = +event.target.value; setVolume(value);
                  if (isNative) nativeControl('volume', value); else player.current?.setVolume?.(value);
                }} /></label>
              <h3>Blocked videos and channels</h3>
              {!Object.keys(blockedVideos).length && !Object.keys(blockedChannels).length && <p>Nothing blocked. Use a song's ••• menu to block recommendations.</p>}
              {Object.entries(blockedVideos).map(([id, title]) => <div className="setting-row" key={id}><span>{title}<small>Video</small></span><button className="secondary" onClick={() => setBlockedVideos((items) => {
                const next = { ...items }; delete next[id]; return next;
              })}>Unblock</button></div>)}
              {Object.entries(blockedChannels).map(([id, title]) => <div className="setting-row" key={id}><span>{title}<small>Channel</small></span><button className="secondary" onClick={() => setBlockedChannels((items) => {
                const next = { ...items }; delete next[id]; return next;
              })}>Unblock</button></div>)}
              <h3>App updates</h3>
              {isNative && <><p>Installed version {nativeAppVersion()}</p><button className="primary" onClick={nativeCheckUpdates}>Check for updates</button></>}
            </section>
          ) : page === 'Sync' ? (
            <div className="sync-page">
              <p className="sync-copy">
                One account, your likes, history, recent videos and playlists — everywhere you use
                Spotitube.
              </p>
              {syncSession ? (
                <>
                  <p className="sync-user">
                    Signed in as <strong>{syncSession.user.email}</strong>
                  </p>
                  <p className="sync-status" role="status">
                    {syncStatus || 'Ready'}
                  </p>
                  <div className="sync-actions">
                    <button className="primary" onClick={() => pushNow()}>
                      Sync now
                    </button>
                    <button
                      className="secondary"
                      onClick={async () => {
                        await signOut();
                        setSyncSession(null);
                        setSyncStatus('');
                      }}
                    >
                      Sign out
                    </button>
                  </div>
                </>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitSync('signin');
                  }}
                >
                  <input
                    type="email"
                    aria-label="Email"
                    placeholder="you@example.com"
                    autoComplete="email"
                    value={syncEmail}
                    onChange={(event) => setSyncEmail(event.target.value)}
                    required
                  />
                  <input
                    type="password"
                    aria-label="Password"
                    placeholder="Password (6+ characters)"
                    autoComplete="current-password"
                    value={syncPassword}
                    onChange={(event) => setSyncPassword(event.target.value)}
                    required
                    minLength={6}
                  />
                  <div className="sync-actions">
                    <button className="primary" type="submit" disabled={syncBusy}>
                      {syncBusy ? 'Working…' : 'Sign in'}
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      disabled={syncBusy}
                      onClick={() => submitSync('signup')}
                    >
                      Create account
                    </button>
                  </div>
                  {syncMessage && (
                    <p role="alert" className="sync-message">
                      {syncMessage}
                    </p>
                  )}
                </form>
              )}
              <p className="sync-note">
                Email + password via Supabase Auth. Your library lives in a row only your account can
                read or write (row level security).
              </p>
            </div>
          ) : page === 'Artist' ? (
            <div className="artist-page">
              <div className="artist-header">
                {artistData?.avatar_url ? (
                  <img className="artist-avatar" src={artistData.avatar_url} alt="" />
                ) : (
                  <div className="artist-avatar artist-avatar-fallback">♫</div>
                )}
                <div>
                  <span className="eyebrow">ARTIST</span>
                  <h1>{artistData?.name || 'Artist'}</h1>
                  <p className="artist-status">
                    {artistStatus ||
                      (artistData
                        ? [
                            typeof artistData.subscribers === 'number' && artistData.subscribers >= 0
                              ? `${artistData.subscribers >= 1e6 ? (artistData.subscribers / 1e6).toFixed(1) + 'M' : artistData.subscribers >= 1e3 ? (artistData.subscribers / 1e3).toFixed(0) + 'K' : artistData.subscribers} subscribers`
                              : null,
                            artistData.uploads.length ? `${artistData.uploads.length} uploads` : null,
                            artistData.playlists.length ? `${artistData.playlists.length} playlists` : null,
                          ].filter(Boolean).join(' · ') || 'YouTube channel'
                        : 'Loading channel…')}
                  </p>
                </div>
              </div>
              {artistData?.description && <p className="artist-description">{artistData.description}</p>}
              {artistData && artistData.playlists.length > 0 && (
                <>
                  <h2>Albums &amp; playlists</h2>
                  {artistData.playlists.map((item) => (
                    <button
                      key={item.id}
                      className="library-link playlist-link"
                      onClick={() => {
                        syncPlaylist(item.id);
                        navigate('My playlist');
                      }}
                    >
                      <i>♫</i>
                      <span>
                        {item.title}
                        <small>{item.count ? `${item.count} videos` : 'Playlist'}</small>
                      </span>
                    </button>
                  ))}
                </>
              )}
              {artistData && artistData.uploads.length > 0 && (
                <>
                  <h2>Uploads</h2>
                  <div className="cards">
                    {artistData.uploads.map((item) => (
                      <button key={item.id} onClick={() => playVideo(item, artistData.uploads)}>
                        <img src={item.thumbnail_url} alt="" />
                        <strong>{item.title}</strong>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {artistData && !artistData.uploads.length && !artistData.playlists.length && !artistStatus && (
                <p className="empty">Nothing public on this channel yet.</p>
              )}
            </div>
          ) : page === 'Offline' ? (
            offlineItems.length ? (
              <>
                <p className="offline-note">
                  Plays without a network · {offlineItems.length} track
                  {offlineItems.length === 1 ? '' : 's'} ·{' '}
                  {(offlineItems.reduce((sum, item) => sum + item.size, 0) / 1048576).toFixed(1)} MB
                </p>
                {offlineItems.map((item, index) => {
                  const asVideo: Video = {
                    id: item.id,
                    title: item.title,
                    author_name: item.author_name,
                    thumbnail_url: item.thumbnail_url,
                  };
                  return (
                    <div className="track" key={item.id}>
                      <button
                        className="track-play"
                        onClick={() =>
                          playEntries(
                            offlineItems.map((row) => entry({
                              id: row.id,
                              title: row.title,
                              author_name: row.author_name,
                              thumbnail_url: row.thumbnail_url,
                            })),
                            index,
                          )
                        }
                      >
                        <span className="index">{index + 1}</span>
                        <img src={item.thumbnail_url} alt="" />
                        <span className="copy">
                          <strong>{item.title}</strong>
                          <small>
                            {item.author_name} · {(item.size / 1048576).toFixed(1)} MB
                          </small>
                        </span>
                      </button>
                      {icon('Delete download', '×', () => nativeDeleteDownload(item.id))}
                    </div>
                  );
                })}
              </>
            ) : (
              <p className="empty">No downloads yet. Tap ↓ on any track to keep it offline.</p>
            )
          ) : shown.length ? (
            shown.map((item, index) =>
              page === 'My playlist' ? (
                <div className={'playlist-select-row' + (listSelection.length ? ' selecting' : '')} key={listRows[index].row.key}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || !(event.target as HTMLElement).closest('.track-play')) return;
                    cancelSelectionHold();
                    suppressSelectionClick.current = false;
                    selectionStart.current = { x: event.clientX, y: event.clientY };
                    selectionHold.current = setTimeout(() => {
                      suppressSelectionClick.current = true;
                      setListSelection((items) => items.includes(listRows[index].offset)
                        ? items : [...items, listRows[index].offset]);
                    }, 500);
                  }}
                  onPointerMove={(event) => {
                    if (Math.hypot(event.clientX - selectionStart.current.x, event.clientY - selectionStart.current.y) > 10) cancelSelectionHold();
                  }}
                  onPointerUp={cancelSelectionHold}
                  onPointerCancel={cancelSelectionHold}
                  onContextMenu={(event) => event.preventDefault()}
                  onClickCapture={(event) => {
                    if (!(event.target as HTMLElement).closest('.track-play')) return;
                    if (suppressSelectionClick.current) {
                      suppressSelectionClick.current = false;
                      event.preventDefault();
                      event.stopPropagation();
                    } else if (listSelection.length) {
                      event.preventDefault();
                      event.stopPropagation();
                      const offset = listRows[index].offset;
                      setListSelection((items) => items.includes(offset)
                        ? items.filter((item) => item !== offset) : [...items, offset]);
                    }
                  }}
                  data-reorder-group="playlist" data-reorder-index={listRows[index].offset}>
                  <div>
                  {listSelection.length > 0 && <input type="checkbox" aria-label={'Select ' + item.title}
                    checked={listSelection.includes(listRows[index].offset)}
                    onChange={(event) => {
                      const offset = listRows[index].offset;
                      setListSelection((items) => event.target.checked
                        ? [...items, offset] : items.filter((value) => value !== offset));
                    }} />}
                  {!selectedList?.source && !listQuery && listSort === 'manual' &&
                    <>
                      {dragHandle('playlist', listRows[index].offset, movePlaylistRow)}
                      <button type="button" aria-label="Move playlist entry up" disabled={index === 0}
                        onClick={() => movePlaylistRow(listRows[index].offset, listRows[index - 1].offset)}>↑</button>
                      <button type="button" aria-label="Move playlist entry down" disabled={index === listRows.length - 1}
                        onClick={() => movePlaylistRow(listRows[index].offset, listRows[index + 1].offset)}>↓</button>
                    </>}
                  </div>
                  {pageRow(item, index, shown, !selectedList?.source)}
                </div>
              ) : pageRow(item, index, shown),
            )
          ) : (
            <p className="empty">
              {page === 'Search'
                ? isNative
                  ? searchStatus || 'Enter a song or artist and tap Search.'
                  : searchMessage || 'No videos found.'
                : page === 'Liked videos'
                  ? 'Tap the heart next to a video to save it here.'
                  : 'Add a YouTube link from Home to build your library.'}
            </p>
          )}
        </section>
        <article className={'panel now' + (video ? ' has-content' : '') +
          (lyrics.status === 'ready' && !lyrics.lyrics.instrumental &&
            (lyrics.lyrics.synced.length || lyrics.lyrics.plain) ? ' has-lyrics' : '')}>
          <div className="panel-heading">
            <h2>Now playing</h2>
            {video && (
              <div className="now-tabs">
                {isNative ? (
                  <>
                    <button
                      type="button"
                      className={nowView === 'art' ? 'active' : ''}
                      onClick={() => setNowView('art')}
                    >
                      Artwork
                    </button>
                    <button
                      type="button"
                      className={nowView === 'lyrics' ? 'active' : ''}
                      onClick={() => setNowView('lyrics')}
                    >
                      Lyrics
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className={audioMode && nowView === 'art' ? 'active' : ''}
                      onClick={() => {
                        setAudioMode(true);
                        setNowView('art');
                      }}
                    >
                      Audio
                    </button>
                    <button
                      type="button"
                      className={!audioMode ? 'active' : ''}
                      onClick={() => setAudioMode(false)}
                    >
                      Video
                    </button>
                    <button
                      type="button"
                      className={audioMode && nowView === 'lyrics' ? 'active' : ''}
                      onClick={() => {
                        setAudioMode(true);
                        setNowView('lyrics');
                      }}
                    >
                      Lyrics
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {video ? (
            <>
              {isNative || audioMode ? (
                <>
                  <audio ref={audio} />
                  {nowView === 'lyrics' ? (
                    <LyricsPane
                      fullscreenRequest={lyricsOpenRequest}
                      onFullscreenClose={() => setLyricsOpenRequest(0)}
                      state={lyrics}
                      playing={playing}
                      trackKey={current?.key}
                      video={video}
                      time={time}
                      onSeek={seek}
                      onRetry={() => setLyricsAttempt((value) => value + 1)}
                    />
                  ) : (
                    <img className="audio-art" src={video.thumbnail_url} alt="" />
                  )}
                </>
              ) : (
                <iframe
                  ref={frame}
                  key={current?.key}
                  title={video.title}
                  src={
                    'https://www.youtube.com/embed/' +
                    video.id +
                    '?enablejsapi=1&playsinline=1&origin=' +
                    encodeURIComponent(location.origin)
                  }
                  referrerPolicy="strict-origin-when-cross-origin"
                  allow="autoplay; encrypted-media"
                  allowFullScreen
                />
              )}
              <h3>{video.title}</h3>
              <button type="button" className="secondary" onClick={() => setBlockTarget(video)}>
                Recommendation preferences
              </button>
              {isNative && video.channel_url ? (
                <p>
                  <button type="button" className="artist-link" onClick={() => goToArtist(video.channel_url)}>
                    {video.author_name}
                  </button>
                </p>
              ) : (
                <p>{video.author_name}</p>
              )}
              <button className="secondary radio-start" onClick={() => startRadio(video)}>
                ♾ Start radio
              </button>
              {isNative && (
                <button
                  type="button"
                  className={'secondary normalize-toggle' + (normalize ? ' active' : '')}
                  aria-pressed={normalize}
                  onClick={() => setNormalize((value) => !value)}
                >
                  {normalize ? 'Normalize on' : 'Normalize off'}
                </button>
              )}
              {playerError && <p role="status">{playerError}</p>}
              {isNative && playerError.startsWith('Playback failed') && (
                <div className="playlist-actions">
                  <button className="secondary" onClick={() => nativeControl('retry')}>Retry</button>
                  <button className="secondary" onClick={() => nativeControl('next')}>Next song</button>
                </div>
              )}
              {isNative && (
                <details onToggle={(event) => { if (!event.currentTarget.open) setCopyStatus(''); }}>
                  <summary>Playback details</summary>
                  <p>{playerError || (playing ? 'Playing' : 'Paused')} · {Math.max(0, Math.floor(buffered - time))} seconds buffered</p>
                  <button className="secondary" onClick={async () => {
                    try {
                      await navigator.clipboard.writeText([
                        'Spotitube playback',
                        ...diagnosticLog,
                        'Buffered ahead: ' + Math.max(0, Math.floor(buffered - time)) + ' seconds',
                      ].join('\n'));
                      setCopyStatus('Copied');
                    } catch { setCopyStatus('Clipboard unavailable'); }
                  }}>Copy diagnostic details</button>
                  {copyStatus && <small role="status">{copyStatus}</small>}
                </details>
              )}
              <a href={'https://www.youtube.com/watch?v=' + video.id} target="_blank" rel="noreferrer">
                Watch on YouTube ↗
              </a>
            </>
          ) : (
            <div className="empty now-empty">
              <span aria-hidden="true">♫</span>
              <strong>A little music goes a long way.</strong>
              <p>Pick a track and settle into your next listen.</p>
            </div>
          )}
        </article>
      </main>
      <footer className="player" aria-label="Playback controls">
        <div className="track-info">
          {!video && (
            <div className="player-placeholder">
              <span aria-hidden="true">♫</span>
              <div>
                Ready when you are
                <small>Choose something to play</small>
              </div>
            </div>
          )}
          {video && (
            <>
              <button type="button" className="player-song-button" aria-label="Open now playing"
                onClick={() => {
                  setNowView('lyrics');
                  if (!isNative) setAudioMode(true);
                  setLyricsOpenRequest((value) => value + 1);
                }}>
                <img src={video.thumbnail_url} alt="" />
                <span className="copy">
                  <strong>{video.title}</strong>
                  <small>{video.author_name}</small>
                </span>
                <span aria-hidden="true">⌃</span>
              </button>
              {icon(
                likes.includes(video.id) ? 'Unlike video' : 'Like video',
                likes.includes(video.id) ? '♥' : '♡',
                () => favorite(video),
                likes.includes(video.id),
              )}
            </>
          )}
        </div>
        <div className="transport">
          <div className="controls">
            {icon('Shuffle', '⤨', changeShuffle, shuffle)}
            {icon(
              'Previous track',
              '⏮',
              () => (time > 3 ? player.current?.seekTo(0, true) : step(-1)),
              false,
              !video,
            )}
            <button
              className="play"
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={!video || Boolean(isNative && !nativeReady)}
              onClick={() => (playing ? player.current?.pauseVideo?.() : player.current?.playVideo?.())}
            >
              {playing ? 'Ⅱ' : '▶'}
            </button>
            {icon('Next track', '⏭', () => step(1), false, !video)}
            {icon(
              ['Repeat off', 'Repeat queue', 'Repeat track'][repeat],
              repeat === 2 ? '↻¹' : '↻',
              () => setRepeat((value) => (value + 1) % 3),
              Boolean(repeat),
            )}
          </div>
          <div className="seek">
            <span>{clock(time)}</span>
            <input
              aria-label="Playback position"
              type="range"
              min="0"
              max={duration || 1}
              value={Math.min(time, duration)}
              disabled={!duration}
              onChange={(event) => {
                const value = +event.target.value;
                seek(value);
              }}
            />
            <span>{clock(duration)}</span>
          </div>
        </div>
        <div className={'extras' + (isNative ? ' android-volume' : '')}>
          {icon('Open queue', '☰', () => navigate('Queue'), page === 'Queue')}
          <button type="button" className="lyrics-shortcut" aria-label="Open lyrics" disabled={!video} onClick={() => {
            setNowView('lyrics');
            if (!isNative) setAudioMode(true);
            setLyricsOpenRequest((value) => value + 1);
          }}>♫ Lyrics</button>
          <label className="volume-control">
            {isNative && <span>{volume}%</span>}
            <input
              aria-label={isNative ? 'Volume and boost' : 'Volume'}
              type="range"
              min="0"
              max={isNative ? 300 : 100}
              value={volume}
              onChange={(event) => {
                const value = +event.target.value;
                setVolume(value);
                if (isNative) nativeControl('volume', value);
                else player.current?.setVolume?.(value);
              }}
            />
          </label>
        </div>
      </footer>
    </>
  );
}

