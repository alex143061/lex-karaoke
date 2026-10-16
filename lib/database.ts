import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const supabaseConfigured = Boolean(supabaseUrl && serviceRoleKey);

const supabase = createClient(
  supabaseUrl || 'http://127.0.0.1:54321',
  serviceRoleKey || 'local-development-key-not-configured',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function requireSupabase() {
  if (!supabaseConfigured) throw new Error('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env, then restart the server.');
}

export type Song = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
};

export type QueueItem = Song & {
  id: string;
  guestId: string;
  guestName: string;
  state: 'queued' | 'playing' | 'played' | 'skipped';
};

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession() {
  requireSupabase();
  const id = randomBytes(18).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const { error } = await supabase.from('karaoke_sessions').insert({ id, host_token_hash: hashToken(token) });
  if (error) throw new Error(`Supabase could not create the session: ${error.message}`);
  return { id, token };
}

export async function isHost(sessionId: string, token: string | undefined) {
  if (!token) return false;
  requireSupabase();
  const { data, error } = await supabase.from('karaoke_sessions')
    .select('host_token_hash').eq('id', sessionId).is('closed_at', null).maybeSingle();
  if (error) throw new Error(`Supabase host check failed: ${error.message}`);
  return data?.host_token_hash === hashToken(token);
}

export async function activeSession(sessionId: string) {
  requireSupabase();
  const { data, error } = await supabase.from('karaoke_sessions')
    .select('id').eq('id', sessionId).is('closed_at', null).maybeSingle();
  if (error) throw new Error(`Supabase session lookup failed: ${error.message}`);
  return Boolean(data);
}

export async function getSnapshot(sessionId: string) {
  requireSupabase();
  const [sessionResult, queueResult] = await Promise.all([
    supabase.from('karaoke_sessions').select('playback_state').eq('id', sessionId).is('closed_at', null).maybeSingle(),
    supabase.from('queue_items').select('id,video_id,title,channel,thumbnail,guest_id,guest_name,state')
      .eq('session_id', sessionId).in('state', ['playing', 'queued'])
      .order('created_at', { ascending: true }).order('id', { ascending: true }),
  ]);
  if (sessionResult.error) throw new Error(`Supabase session lookup failed: ${sessionResult.error.message}`);
  if (queueResult.error) throw new Error(`Supabase queue lookup failed: ${queueResult.error.message}`);
  if (!sessionResult.data) return null;
  const rows = (queueResult.data || []).map((row) => ({
    id: row.id,
    videoId: row.video_id,
    title: row.title,
    channel: row.channel,
    thumbnail: row.thumbnail,
    guestId: row.guest_id,
    guestName: row.guest_name,
    state: row.state as QueueItem['state'],
  }));
  return {
    sessionId,
    playbackState: sessionResult.data.playback_state,
    current: rows.find((item) => item.state === 'playing') ?? null,
    queue: rows.filter((item) => item.state === 'queued'),
  };
}

export async function addSong(sessionId: string, guestId: string, guestName: string, song: Song) {
  requireSupabase();
  const { data, error } = await supabase.rpc('add_queue_song', {
    p_session_id: sessionId,
    p_video_id: song.videoId,
    p_title: song.title,
    p_channel: song.channel,
    p_thumbnail: song.thumbnail,
    p_guest_id: guestId,
    p_guest_name: guestName,
    p_guest_limit: Number(process.env.MAX_PENDING_PER_GUEST || 5),
    p_queue_limit: Number(process.env.MAX_QUEUE_SIZE || 200),
  });
  if (error) throw new Error(error.message.includes('already in queue') ? 'That video is already in the queue.' : error.message);
  return data as string;
}

export async function removeSong(sessionId: string, itemId: string, guestId: string, host: boolean) {
  requireSupabase();
  let query = supabase.from('queue_items').delete().eq('id', itemId).eq('session_id', sessionId).eq('state', 'queued');
  if (!host) query = query.eq('guest_id', guestId);
  const { data, error } = await query.select('id');
  if (error) throw new Error(`Supabase could not remove the request: ${error.message}`);
  return Boolean(data?.length);
}

export async function advanceQueue(sessionId: string) {
  requireSupabase();
  const { error } = await supabase.rpc('advance_queue', { p_session_id: sessionId });
  if (error) throw new Error(`Supabase could not advance the queue: ${error.message}`);
}

export async function closeSession(sessionId: string) {
  requireSupabase();
  const { error } = await supabase.from('karaoke_sessions').update({ closed_at: new Date().toISOString() }).eq('id', sessionId);
  if (error) throw new Error(`Supabase could not close the session: ${error.message}`);
}

export async function setPlaybackState(sessionId: string, state: string) {
  requireSupabase();
  const { error } = await supabase.from('karaoke_sessions').update({ playback_state: state }).eq('id', sessionId);
  if (error) throw new Error(`Supabase could not update playback: ${error.message}`);
}

export async function getCachedSearch(query: string) {
  requireSupabase();
  const { data, error } = await supabase.from('search_cache').select('results,cached_at').eq('query', query).maybeSingle();
  if (error) throw new Error(`Supabase cache lookup failed: ${error.message}`);
  return data ? { results: data.results as Song[], cachedAt: new Date(data.cached_at).getTime() } : undefined;
}

export async function saveCachedSearch(query: string, results: Song[]) {
  requireSupabase();
  const { error } = await supabase.from('search_cache').upsert({ query, results, cached_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase could not save search results: ${error.message}`);
}

export async function consumeSearchQuota(limit: number) {
  requireSupabase();
  const { data, error } = await supabase.rpc('consume_search_quota', { p_limit: limit });
  if (error) throw new Error(`Supabase could not check the local search limit: ${error.message}`);
  return Boolean(data);
}

export async function clearQueue(sessionId: string) {
  requireSupabase();
  const { error } = await supabase.from('queue_items').delete().eq('session_id', sessionId).eq('state', 'queued');
  if (error) throw new Error(`Supabase could not clear the queue: ${error.message}`);
}