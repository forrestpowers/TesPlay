# Changelog

## Unreleased

- Seeking a YouTube video (or any movie or episode) no longer starts the sound before the picture: audio waits until the first frame at the new position is decoded, instead of video catching up by dropping frames.
- Live TV, Movies and Series open the IPTV library of that kind directly, with the categories chosen for it in the sidebar (no All connections step). Movies and Series were blank with `IPTV_ON_DEMAND=1`; they now list the titles.
- YouTube: **Settings → Resolution** in the player lists the H.264 sizes YouTube offers for the video (up to 1080p, 60 fps where that is all a size has) beside **Auto**. The size comes straight from YouTube (no transcoding), the video reopens where it was, and the choice is remembered on that screen.
- YouTube connects only by signing in with your phone: the Data API key and Google web sign-in modes are gone, with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. An older connection that used them asks for the phone sign-in, which replaces its old settings.
- Removed features nothing used: Plex, Stremio, Google Drive and server folder connections (an existing one is listed as no longer supported and can be removed), radio search, phone video uploads and pasted video links, Paste subtitles and Rotate picture in the player, the YouTube card on Home, and the Cloudflare tunnel profile and analytics script allowance.
- IPTV shows live TV only: its movies and series (mostly H.265, which the car cannot play without transcoding) are gone from Home, the IPTV library, category setup and sharing. `IPTV_ON_DEMAND=1` brings them back. The Movies and Series tabs appear only when a connected library can fill them.
- Stremio is no longer offered for new connections for now (Home, Connections and the sign-in page); existing Stremio connections keep working.
- Tapping a YouTube video plays it straight away; the details page with audio, subtitle and quality choices is gone for YouTube, which has nothing to choose there.
- Faster starts: signed-in YouTube links are no longer test-read before playback, the first bytes of each track are fetched while the answer travels to the player, resolved links are reused for up to 30 minutes, and the signed-in player client is prepared when the YouTube tab opens. The app's scripts and styles are served compressed (brotli or gzip) with year-long caching, the player code loads in the background after sign-in, and player preferences are requested alongside the stream instead of before it.
- YouTube **Sign in on this screen**: Google's TV device-code flow (enter a short code at google.com/device on your phone) signs the server in to YouTube's InnerTube API through `youtubei.js`. The YouTube hub gains a real **Home** tab, newest uploads from all subscriptions, account watch history, quota-free search, channel and playlist browsing. Works out of the box with YouTube's own TV-app client; your own Google OAuth client of type “TVs and Limited Input devices” is optional (per connection or `GOOGLE_TV_CLIENT_ID` / `GOOGLE_TV_CLIENT_SECRET`).
- YouTube connects only by signing in with your phone: the Data API key, web OAuth client and custom TV OAuth client options are gone from the app. Older Data API connections keep working until edited; `GOOGLE_TV_CLIENT_ID` still works for server owners.
- Adding YouTube from Connections opens the full-screen phone sign-in (code plus QR for google.com/device) instead of the connection form, and a connection left half-way through sign-in is reused.
- Crunchyroll is no longer listed, and Plex is no longer offered for new connections; existing Plex connections keep working.
- Signed-in YouTube live broadcasts play without yt-dlp: the older TV client lists one URL per track that serves numbered segments, and the server relays the H.264 and AAC tracks as growing fragmented MP4 starting a couple of segments behind the live edge. Works from datacenter addresses where yt-dlp is refused.
- Signed-in YouTube playback asks for the player response as an older TV app version (5.x), which still answers with plain H.264 and AAC URLs where the current TV versions return SABR-only data; the stream plays by byte range with instant seeking, from datacenter addresses too. SABR stays as the fallback.
- Signed-in YouTube playback through SABR (YouTube's server-side adaptive streaming, via `googlevideo`): the server spools H.264 and AAC tracks to `DATA_DIR/youtube-cache`, indexed by their `sidx` so TesPlayer plays them by byte range with seeking and a known duration; parts not yet downloaded restart the stream at that time. Works from addresses YouTube refuses anonymously. `YOUTUBE_SABR=auto|prefer|off`.
- YouTube plays at 720p30 by default (`YOUTUBE_MAX_HEIGHT` raises the ceiling); video selection prefers 30 fps over 60 fps before resolution, and the plain original soundtrack over dubbed, compressed or voice-boosted copies.
- Optional `pot` Compose profile with a proof-of-origin token provider (`YOUTUBE_POT_PROVIDER_URL`) for servers on datacenter addresses; the InnerTube path and the yt-dlp resolver both use it.
- YouTube playback resolves streams through InnerTube first (signed-in TV client, then an anonymous visionOS client with page visitor data): best H.264 track at or below 1080p plus AAC audio, re-chunked into bounded byte ranges by the media proxy. yt-dlp remains the fallback and the live-stream path.

## 0.2.2 — 2026-11-05

- Watch History opens with the 20 most recent titles and shows 20 more at a time.
- Docker Compose groups the services under `tesplay` and reuses the existing named data volume.

## 0.2.0 — 2026-11-04

Initial versioned source release of TesPlay, a self-hosted media hub for the Tesla browser.

- Connected-library browsing for Plex, IPTV, Google Drive, Stremio addons, YouTube and radio, subject to source requirements.
- TesPlayer canvas playback, profiles, saved lists, history, resume and episode navigation.
- QR sign-in, paired phone controls and temporary phone-video upload/conversion.
- Native Node.js and Docker Compose setup with SQLite persistence and encrypted connection credentials.
- Maintainer-reported compatibility with six Intel/AMD Tesla configurations; see [tested vehicles](docs/compatibility.md).
- Paid subscription features removed; noncommercial source licensing and attribution requirements documented.
- Public-facing documentation, demo screenshots and community issue-reporting guidance.

Bring your own authorized media and service accounts. Use only while safely parked in Park. See the [README](README.md) for capabilities, current limits, installation and license terms.
