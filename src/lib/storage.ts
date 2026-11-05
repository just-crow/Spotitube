import type { Playlist, PlaylistEntry } from '../types';
import { uuid } from './format';

export const KEYS = {
  videos: 'videos',
  likes: 'likes',
  history: 'history',
  recent: 'recent-videos',
  playlists: 'spotitube-playlists',
  lyrics: 'spotitube-lyrics-v1',
} as const;

export function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

export function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: keep playing, just skip persisting.
  }
}

/**
 * Local playlists predate stable IDs (they were addressed by array index).
 * Give every playlist a UUID on load so later sync/merge logic has a key.
 */
export function loadPlaylists(): Playlist[] {
  const stored = read<Playlist[]>(KEYS.playlists, []);
  let changed = false;
  const playlists = stored.map((playlist) => {
    if (playlist && typeof playlist.id === 'string' && playlist.id) return playlist;
    changed = true;
    return { ...playlist, id: uuid(), ids: Array.isArray(playlist?.ids) ? playlist.ids : [] };
  });
  if (changed) write(KEYS.playlists, playlists);
  return playlists;
}

export function playlistEntries(playlist: Playlist): PlaylistEntry[] {
  if (playlist.entries?.length === playlist.ids.length &&
      playlist.entries.every((row, index) => row.videoId === playlist.ids[index])) return playlist.entries;
  return playlist.ids.map((videoId, index) => ({ key: playlist.id + ':' + index + ':' + videoId, videoId }));
}

export function withPlaylistIds(playlist: Playlist, ids: string[], addedAt?: number): Playlist {
  const previous = new Map<string, ReturnType<typeof playlistEntries>>();
  for (const row of playlistEntries(playlist)) {
    const rows = previous.get(row.videoId) ?? [];
    rows.push(row);
    previous.set(row.videoId, rows);
  }
  return { ...playlist, ids, entries: ids.map((videoId) =>
    previous.get(videoId)?.shift() ?? { key: uuid(), videoId, addedAt }) };
}
