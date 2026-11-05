import { useLyricsClock } from '../hooks/useLyricsClock';
import { syncLyricAnimation } from '../lib/lyrics-animation';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { chooseLyrics, searchLyricsMatches, type LyricsMatch } from '../lib/lyrics';
import type { Video, LyricWord } from '../types';
import type { LyricsState } from '../hooks/useLyrics';


const TimedWords = memo(function TimedWords({ words, active, read, offset }: {
  words: LyricWord[]; active: boolean; read: () => number; offset: number;
}) {
  const container = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const elements = container.current?.querySelectorAll<HTMLSpanElement>('.lyric-word');
    if (!elements) return;
    if (!active) {
      elements.forEach((element) => {
        element.querySelector('.lyric-word-fill')?.getAnimations().forEach((animation) => animation.cancel());
        element.classList.remove('sung');
      });
      return;
    }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animations = words.map((word, index) => {
      const end = word.endTime ?? words[index + 1]?.time ?? word.time + 0.3;
      const fill = elements[index].querySelector('.lyric-word-fill')!;
      const animation = fill.animate(
        [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }],
        { duration: Math.max(25, (end - word.time) * 1000), fill: 'both', easing: 'linear' },
      );
      animation.pause();
      animation.currentTime = (read() - offset - word.time) * 1000;
      return animation;
    });
    let frame = 0;
    let previous = read() - offset;
    const paint = () => {
      const effective = read() - offset;
      const moving = effective > previous;
      previous = effective;
      words.forEach((word, index) => {
        const element = elements[index];
        const animation = animations[index];
        const duration = Number(animation.effect?.getTiming().duration ?? 0);
        const expected = Math.min(duration, (effective - word.time) * 1000);
        syncLyricAnimation(animation, expected, duration, moving, reducedMotion);
        element.classList.toggle('sung', effective >= word.time &&
          (index === words.length - 1 || effective < words[index + 1].time));
      });
      frame = requestAnimationFrame(paint);
    };
    paint();
    return () => { cancelAnimationFrame(frame); animations.forEach((animation) => animation.cancel()); };
  }, [words, active, read, offset]);
  return <span ref={container}>{words.map((word, index) =>
    <span key={index} className={'lyric-word' + (active ? ' timed' : '')}>{word.text}<span className="lyric-word-fill" aria-hidden="true">{word.text}</span></span>
  )}</span>;
});

type Props = {
  state: LyricsState;
  video?: Video;
  time: number;
  playing?: boolean;
  trackKey?: string;
  fullscreenRequest?: number;
  onFullscreenClose?: () => void;
  onSeek: (seconds: number) => void;
  onRetry?: () => void;
};

export function LyricsPane({ state, time, onSeek, onRetry, video, playing = false, trackKey, fullscreenRequest = 0, onFullscreenClose }: Props) {
  const [fullscreen, setFullscreen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);
  function closeFullscreen() {
    clearTimeout(closeTimer.current);
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setFullscreen(false);
      setClosing(false);
      onFullscreenClose?.();
      returnFocus.current?.focus({ preventScroll: true });
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220);
  }
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const [playerHeight, setPlayerHeight] = useState(0);
  useEffect(() => {
    if (!fullscreen) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') closeFullscreen(); };
    window.addEventListener('keydown', close);
    const player = document.querySelector('.player');
    const measure = () => setPlayerHeight(player?.getBoundingClientRect().height ?? 0);
    const observer = new ResizeObserver(measure);
    if (player) observer.observe(player);
    measure();
    return () => { document.body.style.overflow = previous; observer.disconnect(); window.removeEventListener('keydown', close); };
  }, [fullscreen]);
  function present(content: ReactNode) {
    return fullscreen ? createPortal(<section className={'lyrics-fullscreen' + (closing ? ' is-closing' : '')} aria-label="Full screen now playing"
      style={{ bottom: playerHeight }}>{content}</section>, document.body) : content;
  }
  const [chosen, setChosen] = useState<LyricsMatch>();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<LyricsMatch[]>([]);
  const [searchError, setSearchError] = useState('');
  const matchRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => matchRequest.current?.abort(), [video?.id]);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    if (fullscreenRequest > 0) {
      clearTimeout(closeTimer.current); setClosing(false); setFullscreen(true); setFollowing(true);
    }
  }, [fullscreenRequest]);
  useEffect(() => { setChosen(undefined); setSearching(false); setMatches([]); }, [video?.id]);
  const [offset, setOffset] = useState(0);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const resize = new ResizeObserver(() => {
      const padding = Math.max(24, container.clientHeight / 2 - 32);
      container.style.paddingTop = '16px';
      container.style.paddingBottom = padding + 'px';
      const line = activeRef.current;
      if (line && following) container.scrollTop = Math.max(0, line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2);
    });
    resize.observe(container);
    return () => resize.disconnect();
  }, [state, chosen, fullscreen, following]);
  const manualUntil = useRef(0);
  useEffect(() => { setOffset(0); manualUntil.current = 0; }, [state]);

  const displayState: LyricsState = chosen ? { status: 'ready', lyrics: chosen.lyrics } : state;
  state = displayState;
  const lines = state.status === 'ready' ? state.lyrics.synced : [];
  const clock = useLyricsClock(time, playing, trackKey);
  const effective = clock.time - offset;

  const active = useMemo(() => {
    let index = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= effective) index = i;
      else break;
    }
    return index;
  }, [lines, effective]);

  useEffect(() => {
    if (!following) return;
    const container = listRef.current;
    if (container && active < 0) { container.scrollTop = 0; return; }
    const line = activeRef.current;
    if (!container || !line) return;
    // Scroll only the lyric list, never the page around it.
    const top = line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, top), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [active, following, fullscreen, playerHeight]);
  useEffect(() => {
    if (following) return;
    const timer = setTimeout(() => setFollowing(true), 5000);
    return () => clearTimeout(timer);
  }, [following, time]);
  function browse() {
    setFollowing(false);
    manualUntil.current = Date.now();
  }
  useEffect(() => {
    const timer = setInterval(() => {
      if (manualUntil.current && Date.now() - manualUntil.current >= 5000) setFollowing(true);
    }, 250);
    return () => clearInterval(timer);
  }, []);
  const header = <div className="lyrics-heading">
    <div className="lyrics-toolbar">
      <span className="lyrics-label"><span aria-hidden="true">♫</span> Lyrics</span>
    <button className="lyrics-expand" onClick={() => {
      setFollowing(true);
      if (fullscreen) closeFullscreen();
      else setFullscreen(true);
    }}
      aria-label={fullscreen ? 'Close full screen lyrics' : 'Open full screen lyrics'}>
      {fullscreen ? '↓ Close' : '⛶ Full screen'}
    </button>
    </div>
    <div className="lyrics-track"><strong>{video?.title || 'Your next sing-along'}</strong><small>{video?.author_name}</small></div>
    <button className="lyrics-match-toggle" aria-expanded={searching} onClick={() => { setQuery(video?.title || ''); setSearching(!searching); }}>{searching ? 'Close search' : 'Change lyrics match'}<span aria-hidden="true">{searching ? '−' : '+'}</span></button>
    {searching && <form onSubmit={async (event) => {
      event.preventDefault(); setSearchError('');
      matchRequest.current?.abort();
      const request = new AbortController();
      matchRequest.current = request;
      try {
        const results = await searchLyricsMatches(query, request.signal);
        if (!request.signal.aborted) setMatches(results);
      }
      catch { if (!request.signal.aborted) setSearchError('Could not search lyrics. Try again.'); }
    }}>
      <input aria-label="Song and artist" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button>Search</button>
      {searchError && <p role="alert">{searchError}</p>}
      {matches.map((match, index) => <button type="button" key={index} onClick={() => {
        if (video) chooseLyrics(video.id, match.lyrics);
        setChosen(match); setSearching(false); setOffset(0);
      }}>{match.title} · {match.artist} · {Math.floor(match.duration / 60)}:{String(match.duration % 60).padStart(2, '0')} · {match.lyrics.synced.length ? 'Synced' : 'Unsynced'}</button>)}
    </form>}
  </div>;

  if (fullscreen && video && (state.status !== 'ready' || state.lyrics.instrumental ||
      (!state.lyrics.synced.length && !state.lyrics.plain.trim()))) {
    return present(
      <div className="lyrics-wrap now-playing-artwork">
        {header}
        <div className="now-playing-cover"><img src={video.thumbnail_url} alt={video.title} /></div>
        <p role="status">{state.status === 'loading' ? 'Finding lyrics…' :
          state.status === 'ready' && state.lyrics.instrumental ? 'Instrumental' : 'Lyrics unavailable for this song'}</p>
        {onRetry && state.status !== 'loading' && <button className="secondary" onClick={onRetry}>Try lyrics again</button>}
      </div>,
    );
  }

  if (state.status === 'loading') {
    return present(
      <div className="lyrics lyrics-status lyrics-loading" aria-busy="true">{header}
        <div className="lyrics-skeleton" aria-hidden="true"><i /><i /><i /></div>
        <strong>Finding lyrics…</strong>
        <small>Searching for a synced match.</small>
      </div>
    );
  }

  if (state.status === 'none' || state.status === 'error') {
    return present(
      <div className="lyrics lyrics-status">{header}
        <strong>{state.status === 'error' ? 'Lyrics unavailable' : 'No lyrics found'}</strong>
        <small>
          {state.status === 'error'
            ? 'Could not reach the lyrics service. Check your connection.'
            : 'Nothing matched this track yet.'}
        </small>
        {state.status === 'error' && onRetry && (
          <button type="button" className="secondary" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }

  if (state.status !== 'ready') {
    return present(
      <div className="lyrics lyrics-status">{header}
        <strong>Lyrics</strong>
        <small>Play a track to see its lyrics.</small>
      </div>
    );
  }

  if (state.lyrics.instrumental) {
    return present(
      <div className="lyrics lyrics-status">{header}
        <strong>Instrumental</strong>
        <small>This track has no lyrics.</small>
      </div>
    );
  }

  if (!lines.length) {
    return present(
      <div className="lyrics-wrap">{header}<small className="lyrics-mode">Unsynced lyrics</small>
        <div className="lyrics lyrics-plain">{state.lyrics.plain.split(/\r?\n/).map((line, index) =>
          <p key={index}>{line || '\u00a0'}</p>)}</div>
      </div>
    );
  }

  return present(
    <div className="lyrics-wrap">{header}
      <div className="lyrics-follow-bar">
        <span className="lyrics-mode"><span className="lyrics-sync-dot" aria-hidden="true" />{following ? (lines.some((line) => line.words?.length) ? 'Word-synced lyrics' : 'Synced lyrics') : 'Browsing lyrics'}</span>
        {!following && <button className="lyrics-resume" onClick={() => { manualUntil.current = 0; setFollowing(true); }}>Resume ↗</button>}
      </div>
      <div className="lyrics" ref={listRef}
        onWheel={browse}
        onTouchMove={browse}>
        {lines.map((line, index) => (
          <p
            key={index + ':' + line.time}
            ref={index === active ? activeRef : undefined}
            className={'lyrics-line' + (active >= 0 && line.time === lines[active].time ? ' active' : index < active ? ' past' : '')}
            role="button" tabIndex={0}
            aria-current={index === active ? 'true' : undefined}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault(); onSeek(Math.max(0, line.time + offset));
            } }}
            onClick={() => { manualUntil.current = 0; onSeek(Math.max(0, line.time + offset)); }}
            title="Seek to this line"
          >
            {line.words?.length ? <TimedWords words={line.words} active={active >= 0 && line.time === lines[active].time}
              read={clock.read} offset={offset} /> : <span>{line.text || '♪'}</span>}
          </p>
        ))}
      </div>
      <div className="lyrics-footer">
        <span>{state.lyrics.source || 'lrclib.net'}</span>
        <details className="lyrics-offset"><summary>Timing</summary>
          <button type="button" onClick={() => setOffset((value) => Math.round((value - 0.5) * 10) / 10)}>
            −0.5s
          </button>
          <span>{offset.toFixed(1)}s</span>
          <button type="button" onClick={() => setOffset((value) => Math.round((value + 0.5) * 10) / 10)}>
            +0.5s
          </button>
        </details>
      </div>
    </div>
  );
}
