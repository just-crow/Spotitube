import type { Lyrics, LyricLine } from '../types';

type MuxWord = { start: number; end: number; text: string };
type MuxLine = { start: number; end: number; text: string; words?: MuxWord[] | null };
export type MuxResponse = {
  track: { title: string; artist: string; duration: number };
  meta: { level: string; source?: { name?: string } };
  lines: MuxLine[] | null;
};

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** The API uses absolute milliseconds for both line and word timestamps. */
export function parseMuxLyrics(data: MuxResponse): Lyrics | null {
  if (data?.meta?.level !== 'word' || !Array.isArray(data.lines)) return null;
  const synced: LyricLine[] = [];
  for (const line of data.lines) {
    if (!line || typeof line.text !== 'string' || !validTime(line.start) ||
        !validTime(line.end) || line.end < line.start) continue;
    const candidates = Array.isArray(line.words) ? line.words.filter((word) =>
      word && typeof word.text === 'string' && word.text.length > 0 &&
      validTime(word.start) && validTime(word.end) && word.end > word.start,
    ).map((word) => ({ time: word.start / 1000, endTime: word.end / 1000, text: word.text })) : [];
    const normalizeText = (text: string) => text.replace(/\s+/g, '').normalize('NFC');
    const complete = normalizeText(candidates.map((word) => word.text).join('')) === normalizeText(line.text);
    const ordered = candidates.every((word, index) => index === 0 || word.time >= candidates[index - 1].time);
    const words = complete && ordered ? candidates : [];
    synced.push({ time: line.start / 1000, text: line.text, ...(words.length ? { words } : {}) });
  }
  if (!synced.some((line) => line.words?.length)) return null;
  synced.sort((a, b) => a.time - b.time);
  return {
    synced,
    plain: synced.map((line) => line.text).join('\n'),
    source: 'lrc mux · ' + (data.meta.source?.name || 'word timing'),
  };
}

export async function fetchMuxLyrics(title: string, artist: string, duration: number | undefined,
  signal: AbortSignal): Promise<MuxResponse | null> {
  const request = new AbortController();
  const cancel = () => request.abort();
  if (signal.aborted) return null;
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 8000);
  try {
    const params = new URLSearchParams({ title, artist, level: 'word', strict: 'true', format: 'json' });
    if (duration && Number.isFinite(duration)) params.set('duration', String(Math.round(duration)));
    const response = await fetch('https://api.lrcmux.dev/get?' + params, { signal: request.signal });
    if (!response.ok) return null;
    const data = await response.json() as MuxResponse;
    return typeof data?.track?.title === 'string' && typeof data.track.artist === 'string' ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
