import type { Video } from '../types';

type Props = {
  video: Video;
  index: number;
  isPlaying: boolean;
  liked: boolean;
  saved: boolean;
  hasPlaylists: boolean;
  inPlaylist?: boolean;
  downloadState?: 'idle' | 'downloading' | 'downloaded';
  onDownload?: () => void;
  onPlay: () => void;
  onLike: () => void;
  onSave: () => void;
  onAddToPlaylist?: () => void;
  onRemove?: () => void;
  onQueue: () => void;
  onRadio: () => void;
  onBlock?: () => void;
};

export function TrackRow({
  video,
  index,
  isPlaying,
  liked,
  saved,
  hasPlaylists,
  inPlaylist,
  downloadState,
  onDownload,
  onPlay,
  onLike,
  onSave,
  onAddToPlaylist,
  onRemove,
  onQueue,
  onRadio,
  onBlock,
}: Props) {
  const icon = (label: string, glyph: string, action: () => void, active?: boolean) => (
    <button
      type="button"
      className={'icon ' + (active ? 'active' : '')}
      title={label}
      aria-label={label}
      onClick={action}
    >
      {glyph}
    </button>
  );

  return (
    <div className={'track' + (isPlaying ? ' is-playing' : '')}>
      <button className="track-play" onClick={onPlay}>
        <span className="index">{isPlaying ? '♪' : index + 1}</span>
        <img src={video.thumbnail_url} alt="" />
        <span className="copy">
          <strong>{video.title}</strong>
          <small>{video.author_name}</small>
        </span>
      </button>
      <div className="track-actions">
      {icon(liked ? 'Unlike video' : 'Like video', liked ? '♥' : '♡', onLike, liked)}
      {icon('Start radio', '♾', onRadio)}
      {onDownload &&
        icon(
          downloadState === 'downloaded'
            ? 'Remove download'
            : downloadState === 'downloading'
              ? 'Downloading…'
              : 'Download for offline',
          downloadState === 'downloaded' ? '✓' : '↓',
          onDownload,
          downloadState !== 'idle',
        )}
      {icon('Save video', '⇩', onSave, saved)}
      {hasPlaylists && onAddToPlaylist && icon('Add to playlist', '≡', onAddToPlaylist)}
      {inPlaylist && onRemove && icon('Remove from playlist', '×', onRemove)}
      {icon('Add to queue', '＋', onQueue)}
      {onBlock && <details className="track-more"><summary aria-label="More song options">•••</summary>
        <button type="button" onClick={(event) => {
          event.currentTarget.closest('details')?.removeAttribute('open');
          onBlock();
        }}>Don't recommend…</button>
      </details>}
      </div>
    </div>
  );
}

