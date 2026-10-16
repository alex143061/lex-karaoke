import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
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

export async function POST(request: Request) {
  requireSupabase();
  const body = await request.json();
  const sessionId = body.sessionId;
  const nickname = body.guestName || body.nickname;
  if (!sessionId || !nickname || nickname.trim().length < 1) {
    return NextResponse.json({ error: 'Session ID and nickname are required.' }, { status: 400 });
  }
  const { data, error } = await supabase.from('karaoke_sessions')
    .select('id')
    .eq('id', sessionId)
    .is('closed_at', null)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: 'Session lookup failed.' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Session not found or closed.' }, { status: 404 });
  }
  const guestId = randomBytes(18).toString('base64url');
  return NextResponse.json({
    sessionId: data.id,
    guestId,
    guestName: nickname.trim(),
  });
}
