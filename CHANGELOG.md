# Changelog

## Unreleased

- YouTube **Sign in on this screen**: Google's TV device-code flow (enter a short code at google.com/device on your phone) signs the server in to YouTube's InnerTube API through `youtubei.js`. The YouTube hub gains a real **Home** tab, newest uploads from all subscriptions, account watch history, quota-free search, channel and playlist browsing. Works out of the box with YouTube's own TV-app client; your own Google OAuth client of type “TVs and Limited Input devices” is optional (per connection or `GOOGLE_TV_CLIENT_ID` / `GOOGLE_TV_CLIENT_SECRET`).
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
