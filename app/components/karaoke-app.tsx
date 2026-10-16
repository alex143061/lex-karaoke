'use client';

import { io, type Socket } from 'socket.io-client';
import QRCode from 'qrcode';
import { Disc3, ListMusic, LoaderCircle, Mic2, Play, Plus, Radio, Search, SkipForward, Smartphone, Trash2, Users, Volume2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type Song = { videoId: string; title: string; channel: string; thumbnail: string };
type QueueItem = Song & { id: string; guestName: string; requestedByMe?: boolean; state: 'queued' | 'playing' };
type Snapshot = { sessionId: string; playbackState: string; current: QueueItem | null; queue: QueueItem[] };
type SearchReply = { results?: Song[]; cached?: boolean; error?: string; ok?: boolean };
type Player = { loadVideoById: (id: string) => void; playVideo: () => void; pauseVideo: () => void; destroy: () => void };
type PlayerApi = { Player: new (element: HTMLElement, options: Record<string, unknown>) => Player };
type Props = { mode: 'host' | 'guest'; sessionId?: string };

declare global { interface Window { YT?: PlayerApi; onYouTubeIframeAPIReady?: () => void } }

const hostStorageKey = 'lex-karaoke-host';
const wsUrl = process.env.NEXT_PUBLIC_WS_URL || '';

export default function KaraokeApp({ mode, sessionId: routeSessionId }: Props) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [hostToken, setHostToken] = useState('');
  const [joinUrl, setJoinUrl] = useState('');
  const [qrData, setQrData] = useState('');
  const [connected, setConnected] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);
  const [nickname, setNickname] = useState('');
  const [guestId, setGuestId] = useState('');
  const [joined, setJoined] = useState(false);
  const [pin, setPin] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Song[]>([]);
  const [searchError, setSearchError] = useState('');
  const [cachedResults, setCachedResults] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const playerRef = useRef<Player | null>(null);
  const playerNodeRef = useRef<HTMLDivElement>(null);
  const playerReadyRef = useRef(false);
  const currentVideoRef = useRef('');
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const connection = io({ autoConnect: false });
    socketRef.current = connection;
    setSocket(connection);
    connection.on('connect', () => setConnected(true));
    connection.on('disconnect', () => setConnected(false));
    connection.on('server:status', (status: { supabaseConfigured: boolean }) => setServiceReady(status.supabaseConfigured));
    connection.on('state:update', (state: Snapshot) => setSnapshot(state));
    connection.on('session:closed', () => {
      setJoined(false);
      setSnapshot(null);
      setNotice('The host has closed this session.');
      if (mode === 'host') localStorage.removeItem(hostStorageKey);
    });
    connection.connect();
    return () => { connection.disconnect(); socketRef.current = null; };
  }, [mode]);

  useEffect(() => {
    if (!socket || !connected) return;
    if (mode === 'host') {
      const stored = localStorage.getItem(hostStorageKey);
      if (!stored) return;
      try {
        const session = JSON.parse(stored) as { sessionId: string; token: string };
        socket.emit('session:restore', session, (reply: Snapshot & { hostToken?: string; joinUrl?: string; error?: string }) => {
          if (reply.error) {
            localStorage.removeItem(hostStorageKey);
            return;
          }
          setSnapshot(reply);
          setHostToken(session.token);
          setJoinUrl(reply.joinUrl || '');
          setJoined(true);
        });
      } catch { localStorage.removeItem(hostStorageKey); }
      return;
    }
    const saved = localStorage.getItem(`lex-karaoke-guest-${routeSessionId}`);
    if (!saved) return;
    try {
      const identity = JSON.parse(saved) as { id: string; nickname: string };
      setNickname(identity.nickname);
      socket.emit('session:join', { sessionId: routeSessionId, guestId: identity.id, nickname: identity.nickname }, (reply: Snapshot & { guestId?: string; error?: string }) => {
        if (reply.error) { setNotice(reply.error); return; }
        setGuestId(reply.guestId || identity.id);
        setSnapshot(reply);
        setJoined(true);
      });
    } catch { localStorage.removeItem(`lex-karaoke-guest-${routeSessionId}`); }
  }, [socket, connected, mode, routeSessionId]);

  useEffect(() => {
    if (!joinUrl) { setQrData(''); return; }
    QRCode.toDataURL(joinUrl, { width: 256, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#101919', light: '#ffffff' } })
      .then(setQrData).catch(() => setQrData(''));
  }, [joinUrl]);

  useEffect(() => {
    if (mode !== 'host' || !snapshot?.current || !playerReadyRef.current || !playerRef.current) return;
    const videoId = snapshot.current.videoId;
    if (currentVideoRef.current !== videoId) {
      currentVideoRef.current = videoId;
      playerRef.current.loadVideoById(videoId);
    }
  }, [mode, snapshot?.current?.videoId]);

  useEffect(() => {
    if (mode !== 'host' || !playerNodeRef.current) return;
    let cancelled = false;
    const mountPlayer = () => {
      if (cancelled || !window.YT || !playerNodeRef.current) return;
      playerRef.current = new window.YT.Player(playerNodeRef.current, {
        width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: () => {
            playerReadyRef.current = true;
            const videoId = snapshot?.current?.videoId;
            if (videoId && playerRef.current) {
              currentVideoRef.current = videoId;
              playerRef.current.loadVideoById(videoId);
            }
          },
          onStateChange: (event: { data: number }) => {
            const state = event.data === 1 ? 'playing' : event.data === 3 ? 'buffering' : 'paused';
            socketRef.current?.emit('host:playback', { token: hostToken, state });
            if (event.data === 0) socketRef.current?.emit('host:skip', { token: hostToken }, (reply: SearchReply) => { if (reply.error) setNotice(reply.error); });
          },
          onError: (event: { data: number }) => {
            const errorMessages: Record<number, string> = {
              2: 'Invalid video ID or parameter',
              5: 'HTML5 player error - video may not support embedding',
              100: 'Video not found or private',
              101: 'Video does not allow embedding',
              150: 'Video does not allow embedding',
            };
            const msg = errorMessages[event.data] || `Player error ${event.data}`;
            setNotice(`${msg}. Skipping to the next request.`);
            socketRef.current?.emit('host:skip', { token: hostToken });
          },
        },
      }) as unknown as Player;
    };
    if (window.YT) mountPlayer();
    else {
      const existing = document.querySelector<HTMLScriptElement>('script[data-youtube-iframe]');
      if (!existing) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.dataset.youtubeIframe = 'true';
        document.head.appendChild(script);
      }
      const prior = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prior?.(); mountPlayer(); };
    }
    return () => {
      cancelled = true;
      playerReadyRef.current = false;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [mode, hostToken]);

  useEffect(() => {
    if (!socket || query.trim().length < 2) {
      setResults([]);
      setSearchError('');
      return;
    }
    if (!joined) return;
    const timer = window.setTimeout(() => {
      setLoading(true);
      socket.emit('search', { sessionId: routeSessionId || snapshot?.sessionId, query }, (reply: SearchReply) => {
        setResults(reply.results || []);
        setCachedResults(Boolean(reply.cached));
        setSearchError(reply.error || '');
        setLoading(false);
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [mode, joined, socket, query, routeSessionId, snapshot?.sessionId]);

  function emitAck(event: string, payload: object, onSuccess?: (reply: SearchReply) => void) {
    socket?.emit(event, payload, (reply: SearchReply) => {
      if (reply.error) setNotice(reply.error);
      else { setNotice(''); onSuccess?.(reply); }
    });
  }

  function createRoom() {
    setNotice('');
    emitAck('session:create', { pin }, (reply) => {
      const response = reply as SearchReply & Snapshot & { hostToken?: string; joinUrl?: string };
      if (!response.sessionId || !response.hostToken) return;
      localStorage.setItem(hostStorageKey, JSON.stringify({ sessionId: response.sessionId, token: response.hostToken }));
      setHostToken(response.hostToken);
      setSnapshot(response);
      setJoinUrl(response.joinUrl || '');
      setJoined(true);
      setPin('');
    });
  }

  function joinRoom(event: React.FormEvent) {
    event.preventDefault();
    if (!socket || !routeSessionId) return;
    const saved = localStorage.getItem(`lex-karaoke-guest-${routeSessionId}`);
    const priorId = saved ? (JSON.parse(saved) as { id?: string }).id : undefined;
    emitAck('session:join', { sessionId: routeSessionId, nickname, guestId: priorId }, (reply) => {
      const response = reply as SearchReply & Snapshot & { guestId?: string };
      if (!response.guestId) return;
      localStorage.setItem(`lex-karaoke-guest-${routeSessionId}`, JSON.stringify({ id: response.guestId, nickname: nickname.trim() }));
      setGuestId(response.guestId);
      setSnapshot(response);
      setJoined(true);
      setNotice('');
    });
  }

  function requestSong(song: Song) {
    setBusyId(song.videoId);
    emitAck('queue:add', { song }, () => setNotice(`Added “${song.title}” to the queue.`));
    window.setTimeout(() => setBusyId(''), 700);
  }

  const current = snapshot?.current;
  const queue = snapshot?.queue || [];

  if (mode === 'guest') {
    return <main className="guest-shell">
      <header className="guest-header">
<a className="brand" href="/"><span className="brand-mark"><Mic2 size={18} /></span><span>lex-karaoke</span></a>
        <span className={`connection ${connected ? 'is-online' : ''}`}><span />{connected ? 'Live room' : 'Reconnecting'}</span>
      </header>
      {!joined ? <section className="join-panel">
        <div className="eyebrow"><Smartphone size={14} /> ROOM INVITE</div>
        <h1>Find your voice.</h1>
        <p>Pick a name and jump into the shared queue.</p>
        <form onSubmit={joinRoom} className="join-form">
          <label htmlFor="nickname">Your name</label>
          <input id="nickname" maxLength={24} placeholder="e.g. Jules" value={nickname} onChange={(event) => setNickname(event.target.value)} required />
          <button className="button button-lime button-wide" disabled={!connected}><Mic2 size={17} /> Join the room</button>
        </form>
        {connected && !serviceReady && <p className="notice" role="status">The host needs to configure its Supabase project before this room can be used.</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
      </section> : <>
        <section className="guest-now">
          <div className="eyebrow"><Radio size={14} /> ON STAGE NOW</div>
          {current ? <div className="now-song"><div className="playing-bars"><i /><i /><i /><i /></div><div><strong>{current.title}</strong><span>{current.channel}</span></div></div> : <div className="waiting-song"><Disc3 size={24} /><span>Mic check. First song coming up.</span></div>}
          <div className="now-footer"><span><Users size={14} /> You’re in as {nickname}</span><span>{queue.length} queued</span></div>
        </section>
        <section className="search-section">
          <div className="section-heading"><div><span className="eyebrow">PICK YOUR NEXT SONG</span><h2>Search YouTube</h2></div><span className="search-count">{queue.length} in line</span></div>
          <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Song title or artist" aria-label="Search song title or artist" /><span>↵</span></label>
          {loading && <div className="inline-state"><LoaderCircle size={17} className="spin" /> Searching videos…</div>}
          {searchError && <div className="inline-error">{searchError}</div>}
          {cachedResults && results.length > 0 && <div className="cache-label">Saved results</div>}
          {!loading && query.trim().length >= 2 && results.length === 0 && !searchError && <div className="inline-state">No matches yet. Try a shorter search.</div>}
          <div className="result-list">{results.map((song) => <article className="result-row" key={song.videoId}>
            {song.thumbnail ? <img src={song.thumbnail} alt="" /> : <div className="thumb-fallback"><Disc3 size={20} /></div>}
            <div className="result-copy"><strong>{song.title}</strong><span>{song.channel}</span></div>
            <button className="icon-button add-button" onClick={() => requestSong(song)} disabled={busyId === song.videoId} aria-label={`Add ${song.title}`} title="Add to queue">{busyId === song.videoId ? <LoaderCircle size={18} className="spin" /> : <Plus size={19} />}</button>
          </article>)}</div>
        </section>
        <section className="guest-queue">
          <div className="section-heading"><div><span className="eyebrow">THE LINEUP</span><h2>Coming up</h2></div><ListMusic size={19} /></div>
          {queue.length ? queue.map((item, index) => <QueueRow key={item.id} item={item} position={index + 1} onRemove={() => emitAck('queue:remove', { itemId: item.id })} />) : <p className="queue-empty">No requests yet. Start the set.</p>}
        </section>
      </>}
      {notice && joined && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={15} /></button></div>}
    </main>;
  }

  return <main className="host-shell">
    <header className="host-header">
      <a className="brand" href="/"><span className="brand-mark"><Mic2 size={18} /></span><span>lex-karaoke</span></a>
      <div className="header-meta"><span className={`connection ${connected ? 'is-online' : ''}`}><span />{connected ? 'Server connected' : 'Reconnecting'}</span>{snapshot && <span className="session-chip"><span className="live-pip" /> SESSION LIVE</span>}</div>
    </header>
    {!snapshot ? <section className="welcome-stage">
      <div className="welcome-copy"><div className="eyebrow"><Disc3 size={14} /> YOUR LIVING ROOM, ON STAGE</div><h1>Make a night<br />of <em>every</em> song.</h1><p>Start a room, share the QR, and let the whole group build the setlist from their phones.</p>
        <div className="host-setup"><button className="button button-lime" onClick={createRoom} disabled={!connected || !serviceReady}><Mic2 size={17} /> Start a session</button><label className="pin-input"><span>Host PIN</span><input type="password" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="Only if configured" autoComplete="off" /></label></div>
        {connected && !serviceReady && <p className="notice" role="status">Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env, then restart the server.</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <div className="free-note"><span /> Supabase Free database · no paid hosting</div>
      </div>
      <div className="welcome-art" aria-hidden="true"><div className="art-ring ring-one" /><div className="art-ring ring-two" /><div className="mic-graphic"><Mic2 size={74} strokeWidth={1.15} /></div><span className="art-note note-one">♪</span><span className="art-note note-two">♫</span><span className="art-label">YOUR<br />NEXT<br />FAVOURITE<br />NIGHT</span></div>
    </section> : <>
      <div className="dashboard-title"><div><div className="eyebrow">THE HOST BOOTH <span className="title-dot">/</span> ROOM {snapshot.sessionId.slice(0, 6).toUpperCase()}</div><h1>Tonight’s set</h1></div><button className="button button-outline" onClick={() => emitAck('host:close', { token: hostToken }, () => { localStorage.removeItem(hostStorageKey); setSnapshot(null); setHostToken(''); setJoinUrl(''); })}><X size={16} /> End session</button></div>
      <div className="dashboard-grid">
        <section className="player-column">
          <div className="player-frame"><div ref={playerNodeRef} className="youtube-player" />{!current && <div className="player-placeholder"><div className="placeholder-disc"><Disc3 size={38} /></div><span>THE STAGE IS YOURS</span><strong>{queue.length ? 'Ready for the first song?' : 'Waiting for a request'}</strong><p>{queue.length ? 'Start the set when everyone is ready.' : 'Scan the room QR to add songs.'}</p></div>}</div>
          <div className="current-track"><div className="track-status"><span className={snapshot.playbackState === 'playing' ? 'playing-dot' : 'paused-dot'} />{snapshot.playbackState === 'playing' ? 'NOW PLAYING' : current ? 'READY TO PLAY' : 'UP NEXT'}</div><div className="track-info"><strong>{current?.title || queue[0]?.title || 'No song selected'}</strong><span>{current?.channel || queue[0]?.channel || 'Add a request from a phone to get started'}</span></div><div className="player-controls"><button className="control-button primary-control" title={current ? 'Play' : 'Start next song'} aria-label={current ? 'Play' : 'Start next song'} onClick={() => current ? playerRef.current?.playVideo() : emitAck('host:skip', { token: hostToken })}><Play size={17} fill="currentColor" /></button><button className="control-button" title="Pause" aria-label="Pause" onClick={() => playerRef.current?.pauseVideo()}><span className="pause-glyph">Ⅱ</span></button><button className="control-button" title="Skip song" aria-label="Skip song" onClick={() => emitAck('host:skip', { token: hostToken })}><SkipForward size={18} /></button><button className="control-button" title="Fullscreen" aria-label="Fullscreen" onClick={() => document.querySelector('.player-frame')?.requestFullscreen()}><Volume2 size={17} /></button></div></div>
          {notice && <div className="host-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14} /></button></div>}
        </section>
        <aside className="right-column">
          <section className="search-section">
            <div className="section-heading"><div><span className="eyebrow">ADD A SONG</span><h2>Search YouTube</h2></div><span className="search-count">{queue.length} in line</span></div>
            <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Song title or artist" aria-label="Search song title or artist" /><span>↵</span></label>
            {loading && <div className="inline-state"><LoaderCircle size={17} className="spin" /> Searching videos…</div>}
            {searchError && <div className="inline-error">{searchError}</div>}
            {cachedResults && results.length > 0 && <div className="cache-label">Saved results</div>}
            {!loading && query.trim().length >= 2 && results.length === 0 && !searchError && <div className="inline-state">No matches yet. Try a shorter search.</div>}
            <div className="result-list">{results.map((song) => <article className="result-row" key={song.videoId}>
              {song.thumbnail ? <img src={song.thumbnail} alt="" /> : <div className="thumb-fallback"><Disc3 size={20} /></div>}
              <div className="result-copy"><strong>{song.title}</strong><span>{song.channel}</span></div>
              <button className="icon-button add-button" onClick={() => requestSong(song)} disabled={busyId === song.videoId} aria-label={`Add ${song.title}`} title="Add to queue">{busyId === song.videoId ? <LoaderCircle size={18} className="spin" /> : <Plus size={19} />}</button>
            </article>)}</div>
          </section>
          <section className="invite-panel"><div className="invite-copy"><div className="eyebrow"><Smartphone size={13} /> ADD A SONG</div><strong>Pass the mic.</strong><span>Scan to join this room</span></div>{qrData ? <img className="qr-image" src={qrData} alt="QR code to join this karaoke session" /> : <div className="qr-loading"><LoaderCircle size={20} className="spin" /></div>}<div className="join-address">{joinUrl.replace(/^http:\/\//, '')}</div></section>

          {connected === false && (
            <section className="troubleshoot-panel">
              <div className="eyebrow">Cannot connect?</div>
              <h3>Phone can't reach this computer?</h3>
              <ul className="troubleshoot-list">
                <li>Connect your phone to the <strong>same Wi-Fi</strong> as this PC (turn off mobile data).</li>
                <li>Open this exact URL on your phone browser: <code>{joinUrl}</code></li>
                <li>Allow <strong>Node.js</strong> through Windows Firewall on <strong>Private networks</strong>.</li>
                <li>If the address above is wrong, set <code>LAN_HOST</code> in <code>.env</code> to your PC's IPv4 (e.g. <code>192.168.1.51</code>) and restart.</li>
              </ul>
            </section>
          )}
          <section className="queue-panel"><div className="queue-heading"><div><div className="eyebrow"><ListMusic size={13} /> THE SETLIST</div><h2>Up next <span>{queue.length}</span></h2></div><button className="icon-button clear-button" title="Clear queued songs" aria-label="Clear queued songs" onClick={() => emitAck('host:clear', { token: hostToken })}><Trash2 size={16} /></button></div>
            {current && <div className="now-playing-row"><img src={current.thumbnail} alt="" /><div><span>ON STAGE</span><strong>{current.title}</strong><small>{current.guestName}’s pick</small></div><div className="playing-bars"><i /><i /><i /><i /></div></div>}
            {queue.length ? <div className="host-queue-list">{queue.map((item, index) => <QueueRow key={item.id} item={item} position={index + 1} onRemove={() => emitAck('queue:remove', { itemId: item.id, token: hostToken })} host />)}</div> : !current && <div className="queue-empty host-empty"><ListMusic size={22} /><span>The queue is clear</span><small>Requests appear here in real time.</small></div>}
          </section>
          <div className="room-footnote"><span /> Queue saved on this computer <span className="footnote-separator">·</span> {connected ? 'Live updates on' : 'Reconnecting'}</div>
        </aside>
      </div>
    </>}
  </main>;
}

function QueueRow({ item, position, onRemove, host = false }: { item: QueueItem; position: number; onRemove: () => void; host?: boolean }) {
  const own = !host && item.requestedByMe;
  return <article className={`queue-row ${own ? 'own-request' : ''}`}>
    <span className="queue-position">{String(position).padStart(2, '0')}</span>
    {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <div className="thumb-fallback"><Disc3 size={18} /></div>}
    <div className="queue-copy"><strong>{item.title}</strong><span>{host ? `${item.guestName} · ` : ''}{item.channel}</span>{own && <small>YOUR REQUEST</small>}</div>
    {(own || host) && <button className="icon-button remove-button" onClick={onRemove} aria-label={`Remove ${item.title}`} title="Remove from queue"><X size={16} /></button>}
  </article>;
}