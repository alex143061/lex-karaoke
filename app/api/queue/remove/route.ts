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

export async function POST(request: Request) {
  requireSupabase();
  const body = await request.json();
  const sessionId = body.sessionId;
  const itemId = text(body.itemId, 64);
  const guestId = body.guestId;
  const token = body.token;

  if (!sessionId) {
    return NextResponse.json({ error: 'Join an active session first.' }, { status: 400 });
  }

  const sessionCheck = await supabase.from('karaoke_sessions').select('id').eq('id', sessionId).is('closed_at', null).maybeSingle();
  if (sessionCheck.error || !sessionCheck.data) {
    return NextResponse.json({ error: 'Session not found or closed.' }, { status: 404 });
  }

  let host = false;
  if (token) {
    const { data } = await supabase.from('karaoke_sessions').select('host_token_hash').eq('id', sessionId).maybeSingle();
    host = data?.host_token_hash === createHash('sha256').update(token).digest('hex');
  }

  let query = supabase.from('queue_items').delete().eq('id', itemId).eq('session_id', sessionId).eq('state', 'queued');
  if (!host && guestId) {
    query = query.eq('guest_id', guestId);
  }
  const { data, error } = await query.select('id');
  if (error) {
    return NextResponse.json({ error: 'Could not remove the request.' }, { status: 500 });
  }
  if (!data?.length) {
    return NextResponse.json({ error: 'Only the requester or host can remove this song.' }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
