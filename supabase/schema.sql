create table if not exists public.karaoke_sessions (
  id text primary key,
  host_token_hash text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  playback_state text not null default 'paused'
    check (playback_state in ('playing', 'paused', 'buffering'))
);

create table if not exists public.queue_items (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references public.karaoke_sessions(id) on delete cascade,
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  title text not null,
  channel text not null,
  thumbnail text not null default '',
  guest_id text not null,
  guest_name text not null,
  state text not null default 'queued'
    check (state in ('queued', 'playing', 'played', 'skipped')),
  created_at timestamptz not null default now()
);

create index if not exists queue_session_state_created
  on public.queue_items(session_id, state, created_at);
create unique index if not exists one_active_video_per_session
  on public.queue_items(session_id, video_id) where state in ('queued', 'playing');

create table if not exists public.search_cache (
  query text primary key,
  results jsonb not null default '[]'::jsonb,
  cached_at timestamptz not null default now()
);

create table if not exists public.search_usage (
  usage_date date primary key default current_date,
  calls integer not null default 0 check (calls >= 0)
);

alter table public.karaoke_sessions enable row level security;
alter table public.queue_items enable row level security;
alter table public.search_cache enable row level security;
alter table public.search_usage enable row level security;

grant all on table public.karaoke_sessions to service_role;
grant all on table public.queue_items to service_role;
grant all on table public.search_cache to service_role;
grant all on table public.search_usage to service_role;

create or replace function public.add_queue_song(
  p_session_id text,
  p_video_id text,
  p_title text,
  p_channel text,
  p_thumbnail text,
  p_guest_id text,
  p_guest_name text,
  p_guest_limit integer,
  p_queue_limit integer
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  new_id uuid;
  pending_count integer;
  queue_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session_id, 0));

  if not exists (
    select 1 from karaoke_sessions where id = p_session_id and closed_at is null
  ) then
    raise exception 'This karaoke session has ended.';
  end if;

  if exists (
    select 1 from queue_items where session_id = p_session_id and video_id = p_video_id
      and state in ('playing', 'queued')
  ) then
    raise exception 'That video is already in the queue.';
  end if;

  select count(*) into queue_count from queue_items
    where session_id = p_session_id and state in ('playing', 'queued');
  if queue_count >= p_queue_limit then
    raise exception 'The queue is full.';
  end if;

  select count(*) into pending_count from queue_items
    where session_id = p_session_id and guest_id = p_guest_id and state = 'queued';
  if pending_count >= p_guest_limit then
    raise exception 'You have reached your pending request limit.';
  end if;

  insert into queue_items (session_id, video_id, title, channel, thumbnail, guest_id, guest_name)
    values (p_session_id, p_video_id, left(p_title, 200), left(p_channel, 100), p_thumbnail, p_guest_id, left(p_guest_name, 24))
    returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.advance_queue(p_session_id text)
returns void
language plpgsql
set search_path = public
as $$
declare
  next_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session_id, 0));
  update queue_items set state = 'played'
    where session_id = p_session_id and state = 'playing';
  select id into next_id from queue_items
    where session_id = p_session_id and state = 'queued'
    order by created_at, id limit 1;
  if next_id is not null then
    update queue_items set state = 'playing' where id = next_id;
  end if;
  update karaoke_sessions set playback_state = 'paused' where id = p_session_id;
end;
$$;

create or replace function public.consume_search_quota(p_limit integer)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  current_calls integer;
begin
  insert into search_usage (usage_date, calls) values (current_date, 1)
  on conflict (usage_date) do update set calls = search_usage.calls + 1
    where p_limit <= 0 or search_usage.calls < p_limit
  returning calls into current_calls;
  return current_calls is not null;
end;
$$;

revoke all on function public.add_queue_song(text,text,text,text,text,text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.advance_queue(text) from public, anon, authenticated;
revoke all on function public.consume_search_quota(integer) from public, anon, authenticated;
grant execute on function public.add_queue_song(text,text,text,text,text,text,text,integer,integer) to service_role;
grant execute on function public.advance_queue(text) to service_role;
grant execute on function public.consume_search_quota(integer) to service_role;