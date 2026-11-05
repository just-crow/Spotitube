export type Video = {
  id: string;
  title: string;
  author_name: string;
  thumbnail_url: string;
  channel_id?: string;
  channel_url?: string;
  duration?: number;
};

export type Entry = { key: string; video: Video; recommended?: boolean };

export type PlaylistEntry = { key: string; videoId: string; addedAt?: number };
export type Playlist = { id: string; name: string; ids: string[]; entries?: PlaylistEntry[]; source?: string; refreshedAt?: number };

export type PlaylistRef = { id: string; title: string };

export type LyricWord = { time: number; endTime?: number; text: string };
export type LyricLine = { time: number; text: string; words?: LyricWord[] };

export type Lyrics = {
  synced: LyricLine[];
  plain: string;
  instrumental?: boolean;
  source?: string;
};

export type NativeState = {
  sampleAgeMs?: number;
  positionVersion?: number;
  playing?: boolean;
  time?: number;
  duration?: number;
  ended?: boolean;
  volume?: number;
  key?: string;
  error?: string;
  loading?: boolean;
  buffered?: number;
  preparing?: boolean;
  editableQueue?: boolean;
  index?: number;
  count?: number;
};
