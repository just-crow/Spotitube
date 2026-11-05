import { createClient, type Session } from '@supabase/supabase-js';
import type { Playlist, Video } from '../types';
import { read, write } from './storage';

/**
 * The publishable key is public by design (it identifies the project, not a
 * user). The secret key is for server-side scripts only and must never ship
 * in the app — vite.config.ts fails the build if one sneaks in.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://pziuggvgkpocmnyvcbzk.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_bbpQpmCcPD7YXl8goZdXJQ_D3TIQRx9';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, storageKey: 'spotitube-auth' },
});

export type ResumePosition = {
  id: string;
  title: string;
  author_name: string;
  thumbnail_url: string;
  time: number;
  at: number;
};

export type SyncSnapshot = {
  likes: string[];
  history: string[];
  recent: Video[];
  playlists: Playlist[];
  resume: ResumePosition | null;
  updatedAt: string;
};

const STAMP_KEY = 'spotitube-sync-updated';

export function localStamp(): string {
  return read<string>(STAMP_KEY, '');
}

export function rememberStamp(stamp: string): void {
  write(STAMP_KEY, stamp);
}

export async function currentSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function signIn(email: string, password: string): Promise<string | null> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  return error ? error.message : null;
}

export async function signUp(email: string, password: string): Promise<string | null> {
  const { error } = await supabase.auth.signUp({ email: email.trim(), password });
  return error ? error.message : null;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export async function pullState(userId: string): Promise<SyncSnapshot | null> {
  const { data, error } = await supabase
    .from('spotitube_state')
    .select('likes,history,recent,playlists,resume,updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    likes: Array.isArray(data.likes) ? data.likes : [],
    history: Array.isArray(data.history) ? data.history : [],
    recent: Array.isArray(data.recent) ? data.recent : [],
    playlists: Array.isArray(data.playlists) ? data.playlists : [],
    resume: (data.resume as ResumePosition | null) ?? null,
    updatedAt: data.updated_at,
  };
}

export async function pushState(userId: string, snapshot: Omit<SyncSnapshot, 'updatedAt'>): Promise<string> {
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from('spotitube_state').upsert({
    user_id: userId,
    likes: snapshot.likes,
    history: snapshot.history,
    recent: snapshot.recent,
    playlists: snapshot.playlists,
    resume: snapshot.resume,
    updated_at: updatedAt,
  });
  if (error) throw new Error(error.message);
  return updatedAt;
}
