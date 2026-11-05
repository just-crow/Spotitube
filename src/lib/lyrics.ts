import { fetchMuxLyrics, parseMuxLyrics } from './lrcmux';
import type { LyricLine, Lyrics, Video } from '../types';
import { KEYS, read, write } from './storage';

type CacheEntry = { lyrics: Lyrics | null; at: number };
type LrclibResult = {
  id?: number;
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

const HIT_TTL = 1000 * 60 * 60 * 24 * 30;
const MISS_TTL = 1000 * 60 * 60 * 24 * 3;
const MAX_CACHED = 120;

const overrides: Record<string, Lyrics> = read('spotitube-lyrics-choices', {});
const cache: Record<string, CacheEntry> = read<Record<string, CacheEntry>>('spotitube-lyrics-v4', {});

function remember(id: string, lyrics: Lyrics | null): void {
  cache[id] = { lyrics, at: Date.now() };
  const entries = Object.entries(cache);
  if (entries.length > MAX_CACHED) {
    entries
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, entries.length - MAX_CACHED)
      .forEach(([key]) => delete cache[key]);
  }
  write('spotitube-lyrics-v4', cache);
}

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Strip the noise YouTube uploaders add around song titles. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([]([^:\]\)]*)[)\]]/g, (full, detail: string) => /live|acoustic|remix/i.test(detail) ? ' ' + detail + ' ' : ' ')
    .replace(/\s+-\s+(official|lyrics?|audio|video|visuali[sz]er|music video|hd|hq|4k).*$/i, ' ')
    .replace(/\s+(official|lyric|lyrics|audio|visuali[sz]er|music)\s+(video|music video)?$/i, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Strip channel suffixes like " - Topic" and "VEVO". */
export function cleanArtist(artist: string): string {
  return artist
    .replace(/\s*-\s*topic\s*$/i, '')
    .replace(/\s*vevo\s*$/i, '')
    .replace(/\s+official\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseLrc(text: string): LyricLine[] {
  if (!text) return [];
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?\]/g)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    const wordTags = [...body.matchAll(/<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g)];
    const words = wordTags.flatMap((tag, index) => {
      if (Number(tag[2]) >= 60) return [];
      const text = body.slice(tag.index! + tag[0].length, wordTags[index + 1]?.index ?? body.length);
      if (!text) return [];
      const next = wordTags[index + 1];
      const endTime = next && Number(next[2]) < 60 ? Number(next[1]) * 60 + Number(next[2]) +
        Number((next[3] || '0').padEnd(3, '0')) / 1000 : undefined;
      return [{ time: Number(tag[1]) * 60 + Number(tag[2]) +
        Number((tag[3] || '0').padEnd(3, '0')) / 1000, ...(endTime !== undefined ? { endTime } : {}), text }];
    });
    const content = body.replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '');
    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      if (seconds >= 60) continue;
      const fraction = Number((stamp[3] || '0').padEnd(3, '0')) / 1000;
      const time = minutes * 60 + seconds + fraction;
      const shift = time - (Number(stamps[0][1]) * 60 + Number(stamps[0][2]) +
        Number((stamps[0][3] || '0').padEnd(3, '0')) / 1000);
      const monotonic = words.every((word, index) => index === 0 || word.time >= words[index - 1].time);
      lines.push({ time, text: content, ...(words.length && monotonic
        ? { words: words.map((word) => ({ ...word, time: word.time + shift,
            ...(word.endTime !== undefined ? { endTime: word.endTime + shift } : {}) })) } : {}) });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

function score(result: LrclibResult, video: Video, title: string, artist: string): number {
  let value = 0;
  if (video.duration && result.duration) {
    const delta = Math.abs(result.duration - video.duration);
    if (delta > Math.max(15, video.duration * 0.05)) return -Infinity;
    value += delta <= 2 ? 100 : delta <= 5 ? 60 : delta <= 15 ? 20 : -40;
  }
  const track = normalize(result.trackName || '');
  const wantedTrack = normalize(title);
  if (track && wantedTrack) {
    const wantedWords = wantedTrack.split(' ');
    const common = wantedWords.filter((word) => track.split(' ').includes(word)).length;
    if (common / wantedWords.length < 0.6) return -Infinity;
    if (track === wantedTrack) value += 35;
    else if (track.includes(wantedTrack) || wantedTrack.includes(track)) value += 15;
  }
  const name = normalize(result.artistName || '');
  const wantedArtist = normalize(artist);
  if (name && wantedArtist) {
    if (name === wantedArtist) value += 25;
    else if (name.includes(wantedArtist) || wantedArtist.includes(name)) value += 10;
  }
  const wantsLive = /live|acoustic|remix/i.test(title);
  const isLive = /live|acoustic|remix/i.test(result.trackName || '');
  if (wantsLive !== isLive) value -= 80;
  if (result.syncedLyrics) value += 12;
  return value;
}

function toLyrics(result: LrclibResult): Lyrics | null {
  if (result.instrumental) return { synced: [], plain: '', instrumental: true };
  const synced = parseLrc(result.syncedLyrics || '');
  const plain = (result.plainLyrics || '').trim();
  if (!synced.length && !plain) return null;
  return {
    synced,
    plain,
    source: [result.trackName, result.artistName].filter(Boolean).join(' — ') || undefined,
  };
}

function pick(results: LrclibResult[], video: Video, title: string, artist: string): LrclibResult | null {
  const usable = results.filter((item) => item && (item.syncedLyrics || item.plainLyrics || item.instrumental));
  if (!usable.length) return null;
  let best: LrclibResult | null = null;
  let bestScore = -Infinity;
  for (const item of usable) {
    const value = score(item, video, title, artist);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return bestScore >= 20 ? best : null;
}

export async function fetchLyrics(video: Video, signal: AbortSignal, bypass = false): Promise<Lyrics | null> {
  if (!bypass && overrides[video.id]) return overrides[video.id];
  const cached = cache[video.id];
  if (!bypass && cached && Date.now() - cached.at < (cached.lyrics ? HIT_TTL : MISS_TTL)) {
    return cached.lyrics;
  }

  const parts = video.title.split(/\s+[-–—]\s+/);
  const title = cleanTitle(parts.length > 1 ? parts.slice(1).join(' - ') : video.title);
  const artist = cleanArtist(parts.length > 1 ? parts[0] : video.author_name);
  const mux = await fetchMuxLyrics(title, artist, video.duration, signal);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (mux) {
    const candidate = { trackName: mux.track.title, artistName: mux.track.artist, duration: mux.track.duration };
    const wantedArtist = normalize(artist);
    const actualArtist = normalize(mux.track.artist);
    if (wantedArtist && actualArtist && (wantedArtist.includes(actualArtist) || actualArtist.includes(wantedArtist)) &&
        score(candidate, video, title, artist) >= 20) {
      const lyrics = parseMuxLyrics(mux);
      if (lyrics) { remember(video.id, lyrics); return lyrics; }
    }
  }
  const attempts: string[] = [];
  if (title && artist) attempts.push(`track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`);
  if (title) attempts.push(`q=${encodeURIComponent(`${title} ${artist}`.trim())}`);
  if (title) attempts.push(`track_name=${encodeURIComponent(title)}`);

  let responded = false;
  const candidates: LrclibResult[] = [];
  for (const params of attempts) {
    try {
      const response = await fetch('https://lrclib.net/api/search?' + params, { signal });
      if (!response.ok) continue;
      responded = true;
      const results = (await response.json()) as LrclibResult[];
      if (!Array.isArray(results) || !results.length) continue;
      candidates.push(...results);
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
    }
  }

  const synced = candidates.filter((item) => item.syncedLyrics);
  const best = pick(synced, video, title, artist) ?? pick(candidates, video, title, artist);
  if (best) { const lyrics = toLyrics(best); remember(video.id, lyrics); return lyrics; }
  // Only cache a miss when lrclib actually answered; a network error should retry next time.
  if (!responded) throw new Error('Lyrics service unavailable.');
  remember(video.id, null);
  return null;
}

export type LyricsMatch = { title: string; artist: string; duration: number; lyrics: Lyrics };
export async function searchLyricsMatches(query: string, signal: AbortSignal): Promise<LyricsMatch[]> {
  const response = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(query), { signal });
  if (!response.ok) throw new Error('Search unavailable');
  const results = await response.json() as LrclibResult[];
  return results.flatMap((item) => { const lyrics = toLyrics(item);
    return lyrics ? [{ title: item.trackName || '', artist: item.artistName || '', duration: item.duration || 0, lyrics }] : [];
  });
}
export function chooseLyrics(id: string, lyrics: Lyrics) { overrides[id] = lyrics; write('spotitube-lyrics-choices', overrides); remember(id, lyrics); }
