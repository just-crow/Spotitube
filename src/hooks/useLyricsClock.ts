import { useCallback, useEffect, useRef, useState } from 'react';
import { isNative, nativeState } from '../lib/platform';

export function useLyricsClock(time: number, playing: boolean, trackKey?: string) {
  const [clock, setClock] = useState(time);
  const positionVersion = useRef<number | undefined>(undefined);
  const sample = useRef({ time, playing, at: performance.now() });
  const read = useCallback(() => {
    const anchor = sample.current;
    return anchor.time + (anchor.playing ? Math.min((performance.now() - anchor.at) / 1000, 0.5) : 0);
  }, []);
  useEffect(() => {
    if (!isNative) sample.current = { time, playing, at: performance.now() };
  }, [time, playing, trackKey]);
  useEffect(() => {
    sample.current = { time, playing: false, at: performance.now() };
    positionVersion.current = undefined;
    const update = () => {
      if (isNative) {
        const state = nativeState();
        if (state && state.key === trackKey) {
          const now = performance.now();
          const moving = Boolean(state.playing && !state.loading && !state.error);
          const target = (state.time ?? 0) + (moving ? Math.min(state.sampleAgeMs ?? 0, 500) / 1000 : 0);
          const predicted = read();
          const error = target - predicted;
          // Snap on seeks and play/pause; gently correct ordinary sampling jitter.
          const discontinuity = state.positionVersion !== positionVersion.current;
          positionVersion.current = state.positionVersion;
          const corrected = !moving || moving !== sample.current.playing || discontinuity
            ? target : predicted + Math.max(-0.005, Math.min(0.005, error));
          sample.current = { time: corrected, playing: moving, at: now };
        }
      }
      setClock(read());
    };
    update();
    const timer = setInterval(update, 80);
    return () => clearInterval(timer);
  }, [trackKey, read]);
  return { time: clock, read };
}
