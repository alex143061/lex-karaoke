import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import next from 'next';
import { Server, type Socket } from 'socket.io';
import { privateAddress, validGuestId, validYouTubeVideoId } from './lib/security';
import {
  activeSession,
  addSong,
  advanceQueue,
  clearQueue,
  closeSession,
  consumeSearchQuota,
  createSession,
  getCachedSearch,
  getSnapshot,
  isHost,
  removeSong,
  saveCachedSearch,
  setPlaybackState,
  supabaseConfigured,
  type Song,
} from './lib/database';

const development = process.argv.includes('--dev');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const app = next({ dev: development, hostname: host, port });
const handle = app.getRequestHandler();

async function lanAddress() {
  const configured = process.env.LAN_HOST?.trim();
  if (configured) return configured;
  const routeAddress = await new Promise<string | null>((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const timer = setTimeout(() => finish(null), 1500);
    const finish = (address: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { }
      resolve(address);
    };
    socket.once('error', () => finish(null));
    socket.connect(9, '192.0.2.1', () => finish(socket.address().address));
  });
  if (routeAddress && privateAddress(routeAddress)) return routeAddress;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && privateAddress(address.address)) {
        return address.address;
      }
    }
  }
  return '127.0.0.1';
}

const httpServer = createServer((request, response) => handle(request, response));
const io = new Server(httpServer, { maxHttpBufferSize: 1e5 });
const rateWindows = new Map<string, number[]>();
let hostAddress = '127.0.0.1';

io.use((socket, nextSocket) => {
  if (process.env.ALLOW_PUBLIC_ACCESS !== 'true' && !privateAddress(socket.handshake.address)) {
    nextSocket(new Error('Only local-network connections are allowed.'));
    return;
  }
  nextSocket();
});

function rateAllowed(socket: Socket, key: string, limit: number, windowMs = 60_000) {
  const now = Date.now();
  const bucketKey = `${socket.id}:${key}`;
  const recent = (rateWindows.get(bucketKey) || []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  rateWindows.set(bucketKey, recent);
  return true;
}

function text(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

async function isVideoEmbeddable(videoId: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
      { signal: AbortSignal.timeout(5_000) }
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function sendSnapshot(sessionId: string) {
  const snapshot = await getSnapshot(sessionId);
  if (!snapshot) return;
  for (const socketId of io.sockets.adapter.rooms.get(sessionId) || []) {
    const recipient = io.sockets.sockets.get(socketId);
    if (recipient) recipient.emit('state:update', viewerSnapshot(snapshot, recipient));
  }
}

function viewerSnapshot(snapshot: NonNullable<Awaited<ReturnType<typeof getSnapshot>>>, viewer: Socket) {
  const forViewer = (item: NonNullable<typeof snapshot.current>) => {
    const { guestId, ...publicItem } = item;
    return { ...publicItem, requestedByMe: !viewer.data.isHost && guestId === viewer.data.guestId };
  };
  return {
    ...snapshot,
    current: snapshot.current ? forViewer(snapshot.current) : null,
    queue: snapshot.queue.map(forViewer),
  };
}

function joinUrl(sessionId: string) {
  return `http://${hostAddress}:${port}/join/${encodeURIComponent(sessionId)}`;
}

io.on('connection', (socket) => {
  socket.emit('server:status', { supabaseConfigured });

  const onAck = <T>(event: string, handler: (payload: T, acknowledge: (reply: object) => void) => Promise<void>) => {
    socket.on(event, (payload: T, acknowledge: (reply: object) => void = () => {}) => {
      void handler(payload, acknowledge).catch((error: unknown) => {
        acknowledge({ error: error instanceof Error ? error.message : 'The request could not be completed.' });
      });
    });
  };

  onAck('session:create', async (payload: { pin?: string } = {}, acknowledge) => {
    const localOnly = socket.handshake.address === '127.0.0.1' || socket.handshake.address === '::1' ||
      socket.handshake.address.endsWith(':127.0.0.1');
    const configuredPin = process.env.HOST_PIN;
    if (!localOnly && (!configuredPin || payload.pin !== configuredPin)) {
      acknowledge({ error: 'Create sessions from the host computer, or configure HOST_PIN to allow host setup over Wi-Fi.' });
      return;
    }
    try {
      const session = await createSession();
      socket.join(session.id);
      socket.data.sessionId = session.id;
      socket.data.hostToken = session.token;
      socket.data.isHost = true;
      const snapshot = await getSnapshot(session.id);
      acknowledge({ ...viewerSnapshot(snapshot!, socket), hostToken: session.token, joinUrl: joinUrl(session.id) });
    } catch (error) {
      acknowledge({ error: error instanceof Error ? error.message : 'Could not create a session.' });
    }
  });

  onAck('session:restore', async (payload: { sessionId?: string; token?: string } = {}, acknowledge) => {
    const sessionId = text(payload.sessionId, 80);
    if (!await isHost(sessionId, payload.token)) {
      acknowledge({ error: 'This host session is no longer available.' });
      return;
    }
    socket.join(sessionId);
    socket.data.sessionId = sessionId;
    socket.data.hostToken = payload.token;
    socket.data.isHost = true;
    const snapshot = await getSnapshot(sessionId);
    acknowledge({ ...viewerSnapshot(snapshot!, socket), hostToken: payload.token, joinUrl: joinUrl(sessionId) });
  });

  onAck('session:join', async (payload: { sessionId?: string; nickname?: string; guestId?: string } = {}, acknowledge) => {
    const sessionId = text(payload.sessionId, 80);
    const nickname = text(payload.nickname, 24);
    if (!await activeSession(sessionId)) {
      acknowledge({ error: 'This karaoke session has ended.' });
      return;
    }
    if (!nickname) {
      acknowledge({ error: 'Choose a nickname to join.' });
      return;
    }
    const guestId = validGuestId(payload.guestId) ? payload.guestId : randomUUID();
    socket.join(sessionId);
    socket.data.sessionId = sessionId;
    socket.data.guestId = guestId;
    socket.data.guestName = nickname;
    socket.data.isHost = false;
    acknowledge({ ...viewerSnapshot((await getSnapshot(sessionId))!, socket), guestId });
  });

  onAck('search', async (payload: { sessionId?: string; query?: string } = {}, acknowledge) => {
    const sessionId = text(payload.sessionId, 80);
    let query = text(payload.query, 100).replace(/\s+/g, ' ');
    if (query && !/karaoke/i.test(query)) {
      const suffix = ' karaoke';
      query = (query.slice(0, 100 - suffix.length) + suffix).trim();
    }
    if (socket.data.sessionId !== sessionId || !await activeSession(sessionId)) {
      acknowledge({ error: 'Join an active session before searching.' });
      return;
    }
    if (query.length < 2) {
      acknowledge({ results: [] });
      return;
    }
    if (!rateAllowed(socket, 'search', 12)) {
      acknowledge({ error: 'Search is temporarily rate limited. Try again in a minute.' });
      return;
    }
    const cacheKey = query.toLocaleLowerCase();
    let cached;
    try {
      cached = await getCachedSearch(cacheKey);
    } catch (error) {
      acknowledge({ error: error instanceof Error ? error.message : 'Could not read the saved search cache.' });
      return;
    }
    const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;
    const ttl = Number(process.env.SEARCH_CACHE_TTL_HOURS || 168) * 60 * 60 * 1000;
    if (cached && cacheAge < ttl) {
      acknowledge({ results: cached.results, cached: true });
      return;
    }
    const apiKey = process.env.YOUTUBE_API_KEY?.trim();
    if (!apiKey) {
      acknowledge({
        results: cached?.results || [],
        cached: Boolean(cached),
        error: cached ? 'Showing saved results. Add YOUTUBE_API_KEY for fresh searches.' : 'Fresh search needs a YouTube Data API key. See README for free-quota setup.',
      });
      return;
    }
    const localLimit = Number(process.env.YOUTUBE_DAILY_SEARCH_LIMIT || 100);
    if (!await consumeSearchQuota(localLimit)) {
      acknowledge({
        results: cached?.results || [],
        cached: Boolean(cached),
        error: 'Local daily search limit reached. Cached results are shown when available; the limit resets at midnight UTC.',
      });
      return;
    }
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.search = new URLSearchParams({
        part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '12', q: query, key: apiKey,
      }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: { errors?: { reason?: string }[] } };
        const quota = response.status === 403 && body.error?.errors?.some((item) => item.reason === 'quotaExceeded');
        acknowledge({
          results: cached?.results || [], cached: Boolean(cached),
          error: quota ? 'YouTube search quota is exhausted. Cached results are shown when available; check Google Cloud Console for reset details.' : `YouTube search failed (${response.status}). Cached results are shown when available.`,
        });
        return;
      }
      const body = await response.json() as { items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> } }[] };
      const results: Song[] = (body.items || []).flatMap((item) => {
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
      await saveCachedSearch(cacheKey, results);
      acknowledge({ results, cached: false });
    } catch {
      acknowledge({
        results: cached?.results || [], cached: Boolean(cached),
        error: 'YouTube could not be reached. Cached results are shown when available.',
      });
    }
  });

  onAck('queue:add', async (payload: { song?: Song } = {}, acknowledge) => {
    const { sessionId, guestId, guestName, isHost } = socket.data;
    if (!sessionId || !await activeSession(sessionId)) {
      acknowledge({ error: 'Join the session before requesting a song.' });
      return;
    }
    if (!isHost && (!guestId || !guestName)) {
      acknowledge({ error: 'Join the session before requesting a song.' });
      return;
    }
    const effectiveGuestId = isHost ? 'host' : guestId;
    const effectiveGuestName = isHost ? 'Host' : guestName;
    if (!rateAllowed(socket, 'queue-add', 10)) {
      acknowledge({ error: 'Too many requests. Try again in a minute.' });
      return;
    }
    const song = payload.song;
    if (!song || !validYouTubeVideoId(song.videoId) || !text(song.title, 200) || !text(song.channel, 100)) {
      acknowledge({ error: 'That video selection is invalid.' });
      return;
    }
    if (!(await isVideoEmbeddable(song.videoId))) {
      acknowledge({ error: 'This video cannot be embedded in karaoke. Please choose another song.' });
      return;
    }
    try {
      await addSong(sessionId, effectiveGuestId, effectiveGuestName, {
        videoId: song.videoId,
        title: text(song.title, 200),
        channel: text(song.channel, 100),
        thumbnail: /^https:\/\/(i\.ytimg\.com|img\.youtube\.com)\//.test(song.thumbnail) ? song.thumbnail : '',
      });
      await sendSnapshot(sessionId);
      acknowledge({ ok: true });
    } catch (error) {
      acknowledge({ error: error instanceof Error ? error.message : 'Could not add that song.' });
    }
  });

  onAck('queue:remove', async (payload: { itemId?: string; token?: string } = {}, acknowledge) => {
    const sessionId = socket.data.sessionId as string | undefined;
    const guestId = socket.data.guestId as string | undefined;
    if (!sessionId || !await activeSession(sessionId)) return acknowledge({ error: 'Join an active session first.' });
    const host = await isHost(sessionId, payload.token || socket.data.hostToken);
    if (!await removeSong(sessionId, text(payload.itemId, 64), guestId || '', host)) {
      return acknowledge({ error: 'Only the requester or host can remove this song.' });
    }
    await sendSnapshot(sessionId);
    acknowledge({ ok: true });
  });

  onAck('host:clear', async (payload: { token?: string } = {}, acknowledge) => {
    const sessionId = socket.data.sessionId as string | undefined;
    if (!sessionId || !await isHost(sessionId, payload.token || socket.data.hostToken)) {
      return acknowledge({ error: 'Host permission is required.' });
    }
    await clearQueue(sessionId);
    await sendSnapshot(sessionId);
    acknowledge({ ok: true });
  });

  onAck('host:skip', async (payload: { token?: string } = {}, acknowledge) => {
    const sessionId = socket.data.sessionId as string | undefined;
    if (!sessionId || !await isHost(sessionId, payload.token || socket.data.hostToken)) {
      return acknowledge({ error: 'Host permission is required.' });
    }
    await advanceQueue(sessionId);
    await sendSnapshot(sessionId);
    acknowledge({ ok: true });
  });

  onAck('host:playback', async (payload: { token?: string; state?: string } = {}, _acknowledge) => {
    const sessionId = socket.data.sessionId as string | undefined;
    if (!sessionId || !await isHost(sessionId, payload.token || socket.data.hostToken)) return;
    if (!['playing', 'paused', 'buffering'].includes(payload.state || '')) return;
    await setPlaybackState(sessionId, payload.state!);
    await sendSnapshot(sessionId);
  });

  onAck('host:close', async (payload: { token?: string } = {}, acknowledge) => {
    const sessionId = socket.data.sessionId as string | undefined;
    if (!sessionId || !await isHost(sessionId, payload.token || socket.data.hostToken)) {
      return acknowledge({ error: 'Host permission is required.' });
    }
    await closeSession(sessionId);
    io.to(sessionId).emit('session:closed');
    acknowledge({ ok: true });
  });

  socket.on('disconnect', () => {
    for (const key of rateWindows.keys()) if (key.startsWith(`${socket.id}:`)) rateWindows.delete(key);
  });
});

app.prepare().then(async () => {
  hostAddress = await lanAddress();
  httpServer.listen(port, host, () => {
    console.log(`Karaoke server listening on http://${hostAddress}:${port}`);
  });
});