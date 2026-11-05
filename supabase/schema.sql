-- Spotitube sync: one row per user holding their library as JSON.
-- Run once in the Supabase SQL editor (or with your DB connection string).

create table if not exists public.spotitube_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  likes jsonb not null default '[]'::jsonb,
  history jsonb not null default '[]'::jsonb,
  recent jsonb not null default '[]'::jsonb,
  playlists jsonb not null default '[]'::jsonb,
  resume jsonb,
  updated_at timestamptz not null default now()
);

alter table public.spotitube_state enable row level security;

drop policy if exists "spotitube_state read own" on public.spotitube_state;
create policy "spotitube_state read own"
  on public.spotitube_state for select
  using (auth.uid() = user_id);

drop policy if exists "spotitube_state insert own" on public.spotitube_state;
create policy "spotitube_state insert own"
  on public.spotitube_state for insert
  with check (auth.uid() = user_id);

drop policy if exists "spotitube_state update own" on public.spotitube_state;
create policy "spotitube_state update own"
  on public.spotitube_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
