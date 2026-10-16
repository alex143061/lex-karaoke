import { NextResponse } from 'next/server';
import { randomBytes, createHash } from 'node:crypto';
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
  const pin = body.pin;
  const expectedPin = process.env.host_pin || '1234';
  if (pin !== expectedPin) {
    return NextResponse.json({ error: 'Invalid PIN.' }, { status: 403 });
  }
  const id = randomBytes(18).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const { error } = await supabase.from('karaoke_sessions').insert({
    id,
    host_token_hash: hashToken(token),
  });
  if (error) {
    return NextResponse.json({ error: `Could not create session: ${error.message}` }, { status: 500 });
  }
  const joinUrl = `${new URL(request.url).origin}/join/${id}`;
  return NextResponse.json({ id, token, hostToken: token, joinUrl });
}
