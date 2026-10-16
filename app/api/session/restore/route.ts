import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function requireSupabase() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables.');
  }
}

const supabase = createClient(
  supabaseUrl || 'http://127.0.0.1:54321',
  serviceRoleKey || 'local-development-key-not-configured',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export async function POST(request: Request) {
  requireSupabase();
  const body = await request.json();
  const sessionId = body.sessionId;
  const token = body.token;
  if (!sessionId || !token) {
    return NextResponse.json({ error: 'Session ID and token are required.' }, { status: 400 });
  }
  const { data, error } = await supabase.from('karaoke_sessions')
    .select('id, host_token_hash, playback_state')
    .eq('id', sessionId)
    .is('closed_at', null)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: 'Session lookup failed.' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Session not found or closed.' }, { status: 404 });
  }
  if (data.host_token_hash !== hashToken(token)) {
    return NextResponse.json({ error: 'Invalid host token.' }, { status: 403 });
  }
  const { data: queueData, error: queueError } = await supabase.from('queue_items')
    .select('id,video_id,title,channel,thumbnail,guest_id,guest_name,state')
    .eq('session_id', sessionId)
    .in('state', ['playing', 'queued'])
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (queueError) {
    return NextResponse.json({ error: 'Queue lookup failed.' }, { status: 500 });
  }
  const rows = (queueData || []).map((row: any) => ({
    id: row.id,
    videoId: row.video_id,
    title: row.title,
    channel: row.channel,
    thumbnail: row.thumbnail,
    guestId: row.guest_id,
    guestName: row.guest_name,
    state: row.state,
  }));
  const joinUrl = `${new URL(request.url).origin}/join/${data.id}`;
  return NextResponse.json({
    sessionId: data.id,
    playbackState: data.playback_state,
    current: rows.find((item: any) => item.state === 'playing') ?? null,
    queue: rows.filter((item: any) => item.state === 'queued'),
    hostToken: token,
    joinUrl,
  });
}
