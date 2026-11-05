import { useEffect, useRef, useState } from 'react';
import type { Lyrics, Video } from '../types';
import { fetchLyrics } from '../lib/lyrics';

export type LyricsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; lyrics: Lyrics }
  | { status: 'none' }
  | { status: 'error' };

export function useLyrics(video: Video | undefined, attempt = 0): LyricsState {
  const [state, setState] = useState<LyricsState>({ status: 'idle' });
  const loadedVideo = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!video) {
      loadedVideo.current = undefined;
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    if (loadedVideo.current !== video.id) setState({ status: 'loading' });
    loadedVideo.current = video.id;
    fetchLyrics(video, controller.signal, attempt > 0)
      .then((lyrics) => {
        if (controller.signal.aborted) return;
        setState(lyrics ? { status: 'ready', lyrics } : { status: 'none' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [video?.id, Math.round(video?.duration ?? 0), attempt]);

  return state;
}
