import { NextResponse } from 'next/server';

export async function GET() {
  const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  return NextResponse.json({ configured });
}
