import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  requireSupabase();
  const { sessionId } = await params;
  const [sessionResult, queueResult] = await Promise.all([
    supabase.from('karaoke_sessions').select('playback_state').eq('id', sessionId).is('closed_at', null).maybeSingle(),
    supabase.from('queue_items').select('id,video_id,title,channel,thumbnail,guest_id,guest_name,state')
      .eq('session_id', sessionId).in('state', ['playing', 'queued'])
      .order('created_at', { ascending: true }).order('id', { ascending: true }),
  ]);
  if (sessionResult.error) {
    return NextResponse.json({ error: 'Session lookup failed.' }, { status: 500 });
  }
  if (queueResult.error) {
    return NextResponse.json({ error: 'Queue lookup failed.' }, { status: 500 });
  }
  if (!sessionResult.data) {
    return NextResponse.json({ error: 'Session not found.' }, { status: 404 });
  }
  const rows = (queueResult.data || []).map((row: any) => ({
    id: row.id,
    videoId: row.video_id,
    title: row.title,
    channel: row.channel,
    thumbnail: row.thumbnail,
    guestId: row.guest_id,
    guestName: row.guest_name,
    state: row.state,
  }));
  return NextResponse.json({
    sessionId,
    playbackState: sessionResult.data.playback_state,
    current: rows.find((item: any) => item.state === 'playing') ?? null,
    queue: rows.filter((item: any) => item.state === 'queued'),
  });
}
