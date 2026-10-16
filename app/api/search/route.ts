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

function text(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
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
  let query = text(body.query, 100).replace(/\s+/g, ' ');
  if (query && !/karaoke/i.test(query)) {
    const suffix = ' karaoke';
    query = (query.slice(0, 100 - suffix.length) + suffix).trim();
  }
  if (!sessionId || !query || query.length < 2) {
    return NextResponse.json({ error: 'Session ID and search query are required.' }, { status: 400 });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  const cacheKey = query.toLowerCase();

  const cached = await supabase.from('search_cache').select('results,cached_at').eq('query', cacheKey).maybeSingle();
  const ttlHours = Number(process.env.SEARCH_CACHE_TTL_HOURS || 168);
  const cachedResults = cached?.data?.results as any[] | undefined;
  const now = Date.now();
  if (cachedResults && ttlHours > 0) {
    const cachedAt = (cached?.data as any)?.cached_at || 0;
    const ageHours = (now - new Date(cachedAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < ttlHours) {
      return NextResponse.json({ results: cachedResults, cached: true });
    }
  }

  if (!apiKey) {
    return NextResponse.json({
      results: cachedResults || [],
      cached: Boolean(cachedResults),
      error: cachedResults ? 'Showing saved results. Add YOUTUBE_API_KEY for fresh searches.' : 'Fresh search needs a YouTube Data API key.',
    }, { status: 200 });
  }

  const localLimit = Number(process.env.YOUTUBE_DAILY_SEARCH_LIMIT || 100);
  const quotaResult = await supabase.rpc('consume_search_quota', { p_limit: localLimit });
  if (quotaResult.error || quotaResult.data === false) {
    return NextResponse.json({
      results: cachedResults || [],
      cached: Boolean(cachedResults),
      error: 'YouTube search quota is exhausted. Cached results are shown when available.',
    }, { status: 200 });
  }

  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      maxResults: '12',
      q: query,
      key: apiKey,
    }).toString();
    const response = await fetch(url.toString());
    if (!response.ok) {
      return NextResponse.json({
        results: cachedResults || [],
        cached: Boolean(cachedResults),
        error: `YouTube search failed (${response.status}). Cached results are shown when available.`,
      }, { status: 200 });
    }
    const bodyData = await response.json() as { items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> } }[] };
    const results = (bodyData.items || []).flatMap((item: any) => {
      const videoId = item.id?.videoId;
      const snippet = item.snippet;
      if (!videoId || !snippet?.title) return [];
      const thumbnails = snippet.thumbnails || {};
      return [{
        videoId,
        title: snippet.title.slice(0, 200),
        channel: (snippet.channelTitle || 'YouTube channel').slice(0, 100),
        thumbnail: thumbnails.medium?.url || thumbnails.default?.url || '',
      }];
    });
    await supabase.from('search_cache').upsert({ query: cacheKey, results, cached_at: new Date().toISOString() });
    return NextResponse.json({ results, cached: false });
  } catch {
    return NextResponse.json({
      results: cachedResults || [],
      cached: Boolean(cachedResults),
      error: 'YouTube could not be reached. Cached results are shown when available.',
    }, { status: 200 });
  }
}
