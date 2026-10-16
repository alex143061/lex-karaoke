import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
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

function text(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validYouTubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{11}$/.test(value);
}

async function isVideoEmbeddable(videoId: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
      { signal: AbortSignal.timeout(5000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  requireSupabase();
  const body = await request.json();
  const sessionId = body.sessionId;
  const guestId = body.guestId;
  const guestName = body.guestName;
  const song = body.song;
  const token = body.token;

  if (!sessionId) {
    return NextResponse.json({ error: 'Join an active session first.' }, { status: 400 });
  }

  const sessionCheck = await supabase.from('karaoke_sessions').select('id').eq('id', sessionId).is('closed_at', null).maybeSingle();
  if (sessionCheck.error || !sessionCheck.data) {
    return NextResponse.json({ error: 'Join an active session first.' }, { status: 400 });
  }

  let isHost = false;
  if (token) {
    const { data } = await supabase.from('karaoke_sessions').select('host_token_hash').eq('id', sessionId).maybeSingle();
    isHost = data?.host_token_hash === createHash('sha256').update(token).digest('hex');
  }

  if (!isHost && (!guestId || !guestName)) {
    return NextResponse.json({ error: 'Join the session before requesting a song.' }, { status: 400 });
  }

  const effectiveGuestId = isHost ? 'host' : guestId;
  const effectiveGuestName = isHost ? 'Host' : guestName;

  if (!song || !validYouTubeVideoId(song.videoId) || !text(song.title, 200) || !text(song.channel, 100)) {
    return NextResponse.json({ error: 'That video selection is invalid.' }, { status: 400 });
  }

  if (!(await isVideoEmbeddable(song.videoId))) {
    return NextResponse.json({ error: 'This video cannot be embedded in karaoke. Please choose another song.' }, { status: 400 });
  }

  try {
    const { data, error } = await supabase.rpc('add_queue_song', {
      p_session_id: sessionId,
      p_video_id: song.videoId,
      p_title: text(song.title, 200),
      p_channel: text(song.channel, 100),
      p_thumbnail: /^https:\/\/(i\.ytimg\.com|img\.youtube\.com)\//.test(song.thumbnail) ? song.thumbnail : '',
      p_guest_id: effectiveGuestId,
      p_guest_name: text(effectiveGuestName, 100),
      p_guest_limit: Number(process.env.MAX_PENDING_PER_GUEST || 5),
      p_queue_limit: Number(process.env.MAX_QUEUE_SIZE || 200),
    });
    if (error) {
      return NextResponse.json({ error: error.message.includes('already in queue') ? 'That video is already in the queue.' : error.message }, { status: 400 });
    }
    return NextResponse.json({ ok: true, id: data as string });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Could not add that song.' }, { status: 500 });
  }
}
