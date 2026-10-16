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

export async function POST(request: Request) {
  requireSupabase();
  const body = await request.json();
  const sessionId = body.sessionId;
  const token = body.token;

  if (!sessionId || !token) {
    return NextResponse.json({ error: 'Host permission is required.' }, { status: 403 });
  }

  const { data } = await supabase.from('karaoke_sessions').select('host_token_hash').eq('id', sessionId).maybeSingle();
  if (!data || data.host_token_hash !== createHash('sha256').update(token).digest('hex')) {
    return NextResponse.json({ error: 'Host permission is required.' }, { status: 403 });
  }

  const { error } = await supabase.from('karaoke_sessions').update({ closed_at: new Date().toISOString() }).eq('id', sessionId);
  if (error) {
    return NextResponse.json({ error: 'Could not close session.' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
