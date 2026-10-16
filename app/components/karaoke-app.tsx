'use client';

import QRCode from 'qrcode';
import { Disc3, ListMusic, LoaderCircle, Mic2, Play, Plus, Radio, Search, SkipForward, Smartphone, Trash2, Users, Volume2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type Song = { videoId: string; title: string; channel: string; thumbnail: string };
type QueueItem = Song & { id: string; guestName: string; requestedByMe?: boolean; state: 'queued' | 'playing' };
type Snapshot = { sessionId: string; playbackState: string; current: QueueItem | null; queue: QueueItem[] };
type SearchReply = { results?: Song[]; cached?: boolean; error?: string; ok?: boolean };
type Player = { loadVideoById: (id: string) => void; playVideo: () => void; pauseVideo: () => void; destroy: () => void; getPlayerState: () => number };
type PlayerApi = { Player: new (element: HTMLElement, options: Record<string, unknown>) => Player };
type Props = { mode: 'host' | 'guest'; sessionId?: string };

declare global { interface Window { YT?: PlayerApi; onYouTubeIframeAPIReady?: () => void } }

const hostStorageKey = 'lex-karaoke-host';

export default function KaraokeApp({ mode, sessionId: routeSessionId }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [hostToken, setHostToken] = useState('');
  const [joinUrl, setJoinUrl] = useState('');
  const [qrData, setQrData] = useState('');
  const [connected, setConnected] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);
  const [nickname, setNickname] = useState('');
  const [guestId, setGuestId] = useState('');
  const [joined, setJoined] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Song[]>([]);
  const [searchError, setSearchError] = useState('');
  const [cachedResults, setCachedResults] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [hostPin, setHostPin] = useState('');
  const playerRef = useRef<Player | null>(null);
  const playerNodeRef = useRef<HTMLDivElement>(null);
  const playerReadyRef = useRef(false);
  const currentVideoRef = useRef('');
  const playedVideoRef = useRef(false); // true once we confirm the player is actually playing
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check server configuration status on mount
  useEffect(() => {
    fetch('/api/health')
      .then(async (res) => {
        const data = await res.json();
        setServiceReady(Boolean(data.configured));
      })
      .catch(() => setServiceReady(false));
  }, []);

  useEffect(() => {
    if (!joined || !snapshot?.sessionId) return;
    const id = snapshot.sessionId;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/snapshot/${id}`);
        if (res.status === 404) {
          setJoined(false);
          setSnapshot(null);
          setNotice('The host has closed this session.');
          if (mode === 'host') localStorage.removeItem(hostStorageKey);
          return;
        }
        const data: Snapshot = await res.json();
        setSnapshot(data);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [joined, snapshot?.sessionId, mode]);

  useEffect(() => {
    if (mode !== 'host' || joined) return;
    const stored = localStorage.getItem(hostStorageKey);
    if (!stored) return;
    try {
      const session = JSON.parse(stored) as { sessionId: string; token: string };
      fetch('/api/session/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, token: session.token }),
      })
        .then(async (res) => {
          if (!res.ok) { localStorage.removeItem(hostStorageKey); return; }
          const data = await res.json();
          setSnapshot(data);
          setHostToken(data.hostToken || '');
          setJoinUrl(data.joinUrl || `${window.location.origin}/join/${data.sessionId}`);
          setJoined(true);
        })
        .catch(() => localStorage.removeItem(hostStorageKey));
    } catch { localStorage.removeItem(hostStorageKey); }
  }, [mode, joined]);

  useEffect(() => {
    if (!joinUrl) { setQrData(''); return; }
    QRCode.toDataURL(joinUrl, { width: 256, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#101919', light: '#ffffff' } })
      .then(setQrData).catch(() => setQrData(''));
  }, [joinUrl]);

  const [playbackError, setPlaybackError] = useState('');

  // Centralized: wait for player to exist AND be ready, then load + play, retrying until YouTube confirms playing/buffering state.
  const playVideoFor = (videoId: string) => {
    setPlaybackError('');
    const stage = () => {
      try {
        // Stage 1: wait for the YT.Player instance to exist.
        if (!playerRef.current) {
          setTimeout(stage, 200);
          return;
        }
        // Stage 2: wait for onReady to have fired.
        if (!playerReadyRef.current) {
          setTimeout(stage, 200);
          return;
        }
        // Stage 3: load (if needed) and play, retry until YT reports playing/buffering.
        if (currentVideoRef.current === videoId) {
          playerRef.current.playVideo();
          const state = playerRef.current.getPlayerState?.();
          if (state === 1 || state === 3) {
            playedVideoRef.current = true;
            return;
          }
        } else {
          currentVideoRef.current = videoId;
          playerRef.current.loadVideoById(videoId);
        }
        let attempts = 0;
        const attempt = () => {
          try {
            if (!playerRef.current || currentVideoRef.current !== videoId) return;
            playerRef.current.playVideo();
            const state = playerRef.current.getPlayerState?.();
            if (state === 1 || state === 3) {
              playedVideoRef.current = true;
              return;
            }
            if (++attempts < 100) {
              setTimeout(attempt, 200);
            } else {
              setPlaybackError('YouTube player is not responding. Try refreshing.');
            }
          } catch {
            setPlaybackError('YouTube player error. Try refreshing.');
          }
        };
        setTimeout(attempt, 200);
      } catch {
        setPlaybackError('YouTube player error. Try refreshing.');
      }
    };
    stage();
  };

  // Fast-poll for current song after skip, then play it immediately.
  const playNextSong = async () => {
    if (!snapshot?.sessionId || !hostToken) return;
    setPlaybackError('');
    try {
      await apiCall('/api/host/skip', { sessionId: snapshot.sessionId, token: hostToken });
    } catch {
      setPlaybackError('Could not skip to next song.');
      return;
    }
    // Fast-poll for up to 10 seconds for current to appear.
    let tries = 0;
    const waitForCurrent = () => {
      const c = snapshot?.current;
      if (c?.videoId) {
        playVideoFor(c.videoId);
        return;
      }
      if (++tries < 20) {
        setTimeout(waitForCurrent, 500);
      } else {
        setPlaybackError('Next song did not start. Try refreshing.');
      }
    };
    setTimeout(waitForCurrent, 500);
  };

  const handlePlayClick = () => {
    if (!snapshot?.sessionId || !hostToken) return;
    const c = snapshot?.current;
    if (c?.videoId) {
      playVideoFor(c.videoId);
    } else {
      playNextSong();
    }
  };

  useEffect(() => {
    if (mode !== 'host' || !snapshot?.current?.videoId) return;
    playVideoFor(snapshot.current.videoId);
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
              playVideoFor(videoId);
            }
          },
          onStateChange: (event: { data: number }) => {
            const state = event.data === 1 ? 'playing' : event.data === 3 ? 'buffering' : 'paused';
            if (mode === 'host' && hostToken && snapshot?.sessionId) {
              fetch('/api/host/playback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: snapshot.sessionId, token: hostToken, state }),
              }).catch(() => {});
            }
            // Only skip to next song when the video actually ended after playing.
            // Prevents false skip during initial load/buffering when YT may fire state 0.
            if (event.data === 0 && playedVideoRef.current) {
              fetch('/api/host/skip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: snapshot?.sessionId, token: hostToken }),
              }).catch(() => {});
            }
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
            if (mode === 'host' && hostToken && snapshot?.sessionId) {
              fetch('/api/host/skip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: snapshot.sessionId, token: hostToken }),
              }).catch(() => {});
            }
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
    if (!joined || query.trim().length < 2) {
      setResults([]);
      setSearchError('');
      return;
    }
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: snapshot?.sessionId || routeSessionId || '', query }),
        });
        const data: SearchReply = await res.json();
        setResults(data.results || []);
        setCachedResults(Boolean(data.cached));
        setSearchError(data.error || '');
      } catch {
        setSearchError('Search failed.');
      }
      setLoading(false);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [joined, query, snapshot?.sessionId, routeSessionId]);

  async function apiCall(path: string, body: any) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  function createRoom() {
    setNotice('');
    if (!hostPin) {
      setNotice('Please enter the host PIN.');
      return;
    }
    fetch('/api/session/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: hostPin }),
    })
      .then(async (res) => {
        if (!res.ok) { const err = await res.json(); setNotice(err.error || 'Could not create session.'); return; }
        const data = await res.json();
        setHostToken(data.hostToken || '');
        setJoinUrl(data.joinUrl || `${window.location.origin}/join/${data.id}`);
        localStorage.setItem(hostStorageKey, JSON.stringify({ sessionId: data.id, token: data.token || '' }));
        setJoined(true);
        // Fetch initial snapshot so polling starts
        fetch(`/api/snapshot/${data.id}`)
          .then(async (r) => {
            if (r.ok) {
              const snap = await r.json();
              setSnapshot(snap);
            }
          });
      })
      .catch(() => setNotice('Could not create session.'));
  }

  async function removeCurrentSong() {
    if (!current || !snapshot?.sessionId) return;
    try {
      await apiCall('/api/queue/remove', { sessionId: snapshot.sessionId, itemId: current.id, guestId, token: hostToken });
      await apiCall('/api/host/skip', { sessionId: snapshot.sessionId, token: hostToken });
    } catch {
      setNotice('Could not remove the current song.');
    }
  }

  function joinRoom(event: React.FormEvent) {
    event.preventDefault();
    if (!routeSessionId) return;
    const name = nickname.trim();
    if (!name) { setNotice('Please enter your name.'); return; }
    fetch('/api/session/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: routeSessionId, guestId: crypto.randomUUID(), guestName: name }),
    })
      .then(async (res) => {
        if (!res.ok) { const err = await res.json(); setNotice(err.error || 'Could not join session.'); return; }
        const data = await res.json();
        setGuestId(data.guestId || '');
        setJoined(true);
        localStorage.setItem(`lex-karaoke-guest-${routeSessionId}`, JSON.stringify({ id: data.guestId || '', nickname: name }));
        // Fetch initial snapshot so polling starts
        fetch(`/api/snapshot/${routeSessionId}`)
          .then(async (r) => {
            if (r.ok) {
              const snap = await r.json();
              setSnapshot(snap);
            }
          });
      })
      .catch(() => setNotice('Could not join session.'));
  }

  function requestSong(song: Song) {
    setBusyId(song.videoId);
    apiCall('/api/queue/add', { sessionId: snapshot?.sessionId || routeSessionId, guestId, guestName: nickname, song, token: hostToken })
      .then((reply: any) => {
        if (reply.error) setNotice(reply.error);
        else setNotice(`Added “${song.title}” to the queue.`);
      })
      .finally(() => { window.setTimeout(() => setBusyId(''), 700); });
  }

  function removeSong(itemId: string) {
    apiCall('/api/queue/remove', { sessionId: snapshot?.sessionId || routeSessionId, itemId, guestId, token: hostToken })
      .then((reply: any) => {
        if (reply.error) setNotice(reply.error);
        else setNotice('Removed from queue.');
      });
  }

  function clearQueue() {
    apiCall('/api/host/clear', { sessionId: snapshot?.sessionId, token: hostToken })
      .then((reply: any) => {
        if (reply.error) setNotice(reply.error);
        else setNotice('Queue cleared.');
      });
  }

  function skipSong() {
    apiCall('/api/host/skip', { sessionId: snapshot?.sessionId, token: hostToken })
      .then((reply: any) => {
        if (reply.error) setNotice(reply.error);
        else setNotice('Skipping song.');
      });
  }

  function setPlayback(state: string) {
    apiCall('/api/host/playback', { sessionId: snapshot?.sessionId, token: hostToken, state });
  }

  function closeSession() {
    if (!window.confirm('Close this session? All queued songs will be cleared.')) return;
    apiCall('/api/host/close', { sessionId: snapshot?.sessionId, token: hostToken })
      .then((reply: any) => {
        if (reply.error) setNotice(reply.error);
        else {
          setJoined(false);
          setSnapshot(null);
          setNotice('Session closed.');
          localStorage.removeItem(hostStorageKey);
        }
      });
  }

  const current = snapshot?.current;
  const queue = snapshot?.queue || [];

  if (mode === 'guest') {
    return <main className="guest-shell">
      <header className="guest-header">
      <a className="brand" href="/"><span className="brand-mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M9.5 13.5v.01"/></svg></span><span>lex-karaoke</span></a>
        <span className={`connection ${serviceReady ? 'is-online' : ''}`}><span />{serviceReady ? 'Server connected' : 'Server not ready'}</span>
      </header>
      {!joined ? <section className="join-panel">
        <div className="eyebrow"><Smartphone size={14} /> ROOM INVITE</div>
        <h1>Find your voice.</h1>
        <p>Pick a name and jump into the shared queue.</p>
        <form onSubmit={joinRoom} className="join-form">
          <label htmlFor="nickname">Your name</label>
          <input id="nickname" maxLength={24} placeholder="e.g. Jules" value={nickname} onChange={(event) => setNickname(event.target.value)} required />
          <button className="button button-lime button-wide" disabled={!serviceReady}><Mic2 size={17} /> Join the room</button>
        </form>
        {connected && !serviceReady && <p className="notice" role="status">The server needs to be configured before this room can be used.</p>}
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
          {queue.length ? queue.map((item, index) => <QueueRow key={item.id} item={item} position={index + 1} onRemove={() => apiCall('/api/queue/remove', { sessionId: snapshot?.sessionId, itemId: item.id, guestId })} />) : <p className="queue-empty">No requests yet. Start the set.</p>}
        </section>
      </>}
      {notice && joined && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={15} /></button></div>}
    </main>;
  }

  return <main className="host-shell">
    <header className="host-header">
      <a className="brand" href="/"><span className="brand-mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M9.5 13.5v.01"/></svg></span><span>lex-karaoke</span></a>
      <div className="header-meta"><span className={`connection ${serviceReady ? 'is-online' : ''}`}><span />{serviceReady ? 'Server connected' : 'Server not ready'}</span></div>
    </header>
    {!snapshot ? <section className="welcome-stage">
      <div className="welcome-copy"><div className="eyebrow"><Disc3 size={14} /> YOUR LIVING ROOM, ON STAGE</div><h1>Make a night<br />of <em>every</em> song.</h1><p>Start a room, share the QR, and let the whole group build the setlist from their phones.</p>
        <div className="host-setup"><label className="search-box"><span>Host PIN</span><input value={hostPin} onChange={(e) => setHostPin(e.target.value)} type="password" placeholder="Enter host PIN" aria-label="Host PIN" /><span>â†µ</span></label><button className="button button-lime" onClick={createRoom} disabled={!serviceReady || !hostPin}><Mic2 size={17} /> Start a session</button></div>
        {connected && !serviceReady && <p className="notice" role="status">Configure server settings, then refresh the page.</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <div className="free-note"><span /> Connected to database · no paid services</div>
      </div>
      <div className="welcome-art" aria-hidden="true"><div className="art-ring ring-one" /><div className="art-ring ring-two" /><div className="mic-graphic"><Mic2 size={74} strokeWidth={1.15} /></div><span className="art-note note-one">♪</span><span className="art-note note-two">♫</span><span className="art-label">YOUR<br />NEXT<br />FAVOURITE<br />NIGHT</span></div>
    </section> : <>
      <div className="dashboard-title"><div><div className="eyebrow">THE HOST BOOTH <span className="title-dot">/</span> ROOM {snapshot.sessionId.slice(0, 6).toUpperCase()}</div><h1>Tonight’s set</h1></div><button className="button button-outline" onClick={() => { apiCall('/api/host/close', { sessionId: snapshot?.sessionId, token: hostToken }).then(() => { localStorage.removeItem(hostStorageKey); setSnapshot(null); setHostToken(''); setJoinUrl(''); }); }}><X size={16} /> End session</button></div>
      <div className="dashboard-grid">
        <section className="player-column">
          <div className="player-frame"><div ref={playerNodeRef} className="youtube-player" />{!current && <div className="player-placeholder"><div className="placeholder-disc"><Disc3 size={38} /></div><span>THE STAGE IS YOURS</span><strong>{queue.length ? 'Ready for the first song?' : 'Waiting for a request'}</strong><p>{queue.length ? 'Start the set when everyone is ready.' : 'Scan the room QR to add songs.'}</p></div>}</div>
          <div className="current-track"><div className="track-status"><span className={snapshot.playbackState === 'playing' ? 'playing-dot' : 'paused-dot'} />{snapshot.playbackState === 'playing' ? 'NOW PLAYING' : current ? 'READY TO PLAY' : 'UP NEXT'}</div><div className="track-info"><strong>{current?.title || queue[0]?.title || 'No song selected'}</strong><span>{current?.channel || queue[0]?.channel || 'Add a request from a phone to get started'}</span></div><div className="player-controls"><button className="control-button primary-control" title={current ? 'Play' : 'Start next song'} aria-label={current ? 'Play' : 'Start next song'} onClick={handlePlayClick}><Play size={17} fill="currentColor" /></button><button className="control-button" title="Pause" aria-label="Pause" onClick={() => playerRef.current?.pauseVideo()}><span className="pause-glyph">Ⅱ</span></button><button className="control-button" title="Skip song" aria-label="Skip song" onClick={() => apiCall('/api/host/skip', { sessionId: snapshot?.sessionId, token: hostToken })}><SkipForward size={18} /></button><button className="control-button" title="Fullscreen" aria-label="Fullscreen" onClick={() => document.querySelector('.player-frame')?.requestFullscreen()}><Volume2 size={17} /></button></div></div>
          {notice && <div className="host-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14} /></button></div>}
          {playbackError && <div className="host-notice" role="status" style={{ color: '#ef4444' }}>{playbackError}<button onClick={() => setPlaybackError('')} aria-label="Dismiss"><X size={14} /></button></div>}
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
          <section className="queue-panel"><div className="queue-heading"><div><div className="eyebrow"><ListMusic size={13} /> THE SETLIST</div><h2>Up next <span>{queue.length}</span></h2></div><button className="icon-button clear-button" title="Clear queued songs" aria-label="Clear queued songs" onClick={() => apiCall('/api/host/clear', { sessionId: snapshot?.sessionId, token: hostToken })}><Trash2 size={16} /></button></div>
            {current && <div className="now-playing-row"><img src={current.thumbnail} alt="" /><div><span>ON STAGE</span><strong>{current.title}</strong><small>{current.guestName}’s pick</small></div><div className="playing-bars"><i /><i /><i /><i /></div><button className="icon-button remove-button" onClick={removeCurrentSong} title="Remove current song" aria-label="Remove current song"><X size={16} /></button></div>}
            {queue.length ? <div className="host-queue-list">{queue.map((item, index) => <QueueRow key={item.id} item={item} position={index + 1} onRemove={() => apiCall('/api/queue/remove', { sessionId: snapshot?.sessionId, itemId: item.id, guestId, token: hostToken })} host />)}</div> : !current && <div className="queue-empty host-empty"><ListMusic size={22} /><span>The queue is clear</span><small>Requests appear here in real time.</small></div>}
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