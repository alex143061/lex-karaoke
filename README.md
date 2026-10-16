# Singalong Local Karaoke

A Windows-hosted karaoke dashboard and mobile controller for one private Wi-Fi network. Next.js and Socket.IO run on the host PC; Supabase Postgres stores sessions, queue items, and cached YouTube searches. The browser clients never connect to Supabase directly. This version uses a hosted Supabase database, so it is not fully local-only and the host needs internet access for Supabase and YouTube searches.

The app, libraries, QR generation, and local server are free/open source. Supabase Free is currently listed at $0 with 500 MB database storage, 5 GB egress, and up to two active projects; free projects may pause after a week of inactivity. Limits and terms can change. Choose only the Free plan and do not enable a paid upgrade or add paid services. When a free limit is reached or the project pauses, database-backed sessions and queue actions will be unavailable until the free project is usable again. No paid fallback is built in.

YouTube search uses the official Data API v3 and its limited project quota. Playback uses the official IFrame Player API. Video availability, ads, embedding restrictions, and regional restrictions are controlled by YouTube and the video owner. The app does not download videos or extract audio.

## Requirements

- Windows 10 or 11
- Node.js 24 LTS recommended; Node.js 22.13 or newer is supported
- A Supabase account and project kept on the Free plan
- Host PC and phones on the same private Wi-Fi
- Internet access on the host for Supabase and fresh YouTube searches

## Supabase setup

1. Create a Supabase organization/project and select the **Free** plan. Do not upgrade the project or organization.
2. In the Supabase Dashboard, open **SQL Editor**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run it. It creates the tables, indexes, row-level security settings, and atomic queue/quota functions. Optionally run [`supabase/seed.sql`](supabase/seed.sql) for an empty search-cache smoke fixture; it deliberately contains no video IDs.
3. From the project settings, copy the project URL and the server-side `service_role` secret key. Do not use the `anon`/publishable key here.
4. Copy `.env.example` to `.env`, then set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The service-role key bypasses row-level security and must remain secret; it is only read by the Node server and must never be prefixed with `NEXT_PUBLIC_` or committed to Git.

Row-level security is enabled on all application tables with no anonymous policies. Only the local Node server uses the service-role key after checking host tokens and guest ownership. Do not expose the server publicly or share its `.env` file.

## Install and run on Windows

1. Install Node.js from [nodejs.org](https://nodejs.org/) and verify `node --version` is 22.13 or newer.
2. Open this folder in VS Code or PowerShell.
3. Install dependencies:

   ```powershell
   npm install
   ```

4. Complete the Supabase setup above. YouTube search setup is optional.
5. Start in development mode:

   ```powershell
   npm run dev
   ```

   Open `http://localhost:3000` on the host PC. For a production-style run, `npm start` builds the app if needed and starts the same local server. Stop with Ctrl+C.

The server binds to `0.0.0.0` so phones on the LAN can connect. If Windows Defender Firewall prompts, allow Node.js on **Private networks only**. Do not enable public-network access or router port forwarding. If automatic LAN address detection chooses the wrong adapter, set `LAN_HOST` in `.env` to the PC's private IPv4 address (for example `192.168.1.25`) and restart.

## Join a room

1. Start a session in the host dashboard.
2. Scan the displayed QR code with a phone camera, or open the displayed `http://<LAN-IP>:3000/join/<session>` URL.
3. Enter a nickname. Search by song title or artist and add a result to the shared queue.
4. The host can play, pause, skip, remove any queued song, clear queued requests, and end the session. Guests can remove only their own queued songs.

The default host creation action is restricted to a loopback connection. To create a room while browsing the host dashboard through its LAN address, configure `HOST_PIN` in `.env` and enter that PIN. Host tokens are randomly generated, kept in host-browser local storage, and stored only as hashes in Supabase.

## Optional YouTube Data API key

1. In Google Cloud Console, create/select a project and enable **YouTube Data API v3**. Create an API key and restrict it to this API where the console permits.
2. Review the project's current YouTube Data API quota and method costs in Google Cloud Console. Quotas and allocation can change; search is not unlimited.
3. Set `YOUTUBE_API_KEY` in `.env` and restart the local server. The key is used only by the Node server.
4. `YOUTUBE_DAILY_SEARCH_LIMIT` is an extra local calls-per-UTC-day guard, not Google's quota and not a quota increase. Set it conservatively for your project. Cached results may be shown on quota or network errors, but caching does not make fresh search unlimited.

Fresh YouTube searches require internet access and an API key. Queue and session operations require internet access to the hosted Supabase project. The YouTube key is optional, but Supabase credentials are required for the application to operate.

## Configuration and checks

See `.env.example` for server port/bind address, LAN IP override, host PIN, queue limits, cache lifetime, search limit, and credentials. `.env` is ignored by Git.

```powershell
npm run typecheck
npm test
npm run build
npm start
```

Apply schema changes by running the updated `supabase/schema.sql` in the Supabase SQL Editor. No local SQLite database is used in this Supabase version. The test suite covers local security validation; live Supabase, YouTube quota, phone Wi-Fi, and embedded-video behavior require credentials/devices and are not covered by automated tests.

## Troubleshooting

- **Supabase is not configured:** set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`, confirm the SQL schema ran successfully, then restart.
- **Supabase permission/schema error:** confirm the service-role secret is correct and the SQL schema/functions were applied to the same project URL.
- **Project is paused:** free Supabase projects may pause after inactivity. Resume it in the Supabase Dashboard; no paid upgrade is required for this app's basic use.
- **Phone cannot open the QR URL:** both devices must be on the same Wi-Fi, Windows Firewall must allow Node on a private network, and the router must permit device-to-device connections. Guest Wi-Fi/client isolation often blocks this.
- **QR shows `127.0.0.1`:** set `LAN_HOST` to the host PC's private IPv4 address. A phone's localhost points to the phone itself.
- **Search needs a key/quota error:** configure `YOUTUBE_API_KEY`; check the live project quota in Google Cloud Console. The app falls back to cached results when available and never switches to a paid search API.
- **Video fails to play:** the video may be private, restricted, unavailable, region-blocked, or not embeddable. The host player reports an error and advances the queue. Browser autoplay may also require a user click.
- **Wrong port:** set `PORT` in `.env`, restart, and use the new port shown by the server.

## Privacy and limitations

This is a local-network web server backed by a hosted database, not an offline/local-only system. Session IDs, hashed host tokens, nicknames, queue metadata, cached search results, and local search counters are stored in the selected Supabase project. Search queries are sent to Google when fresh search is requested; video playback is provided by YouTube. Use a private Wi-Fi network. The app does not provide or license karaoke content and cannot guarantee that search results are available or permitted to embed.