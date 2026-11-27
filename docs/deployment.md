# Deployment and connection setup

The app runs on your hardware. Your Mac/Pi needs access to Plex, IPTV, Drive and any mounted share; the Tesla needs access to the app's public HTTPS address. TesPlay supplies its own owner login and encrypted credentials; an optional access gateway can add another login layer.

## First installation

Start with the [Docker or native quick start](../README.md#quick-start). Copy `.env.example` to a private `.env`, start the app, and create the owner using the setup code printed in the server output. Keep the host running while using TesPlay.

The default local address is `http://127.0.0.1:4174`. For phone and Tesla access, configure your own reachable HTTPS origin and set `PUBLIC_URL` to it. `media.example.com` throughout this guide is a placeholder for your hostname.

Compose mounts application data at `/app/data` in a persistent volume and mounts the host folder selected by `MEDIA_DIR` read-only at `/media`. Keep your database, encryption key, environment file and tunnel credentials outside source control.

Cloudflare Tunnel and Access are optional. Use your chosen HTTPS reverse proxy or tunnel; if you enable an additional access layer, both the phone and the vehicle browser must complete it.

## Environment settings

| Variable                  | Meaning                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`, `PORT`            | Native defaults: `127.0.0.1`, `4174`. Compose uses `0.0.0.0` inside the container while publishing loopback only.                                             |
| `DATA_DIR`                | Native SQLite/key directory. Compose fixes it to `/app/data` in the named volume.                                                                             |
| `PUBLIC_URL`              | Exact browser origin, with no path. Use `https://media.example.com` publicly. Also controls OAuth redirect and secure cookies.                            |
| `TRUST_PROXY`             | `0` for direct local access. `1` for the single trusted connector described here. Do not use a blanket trust setting for an exposed origin.                   |
| `SETUP_TOKEN`             | Optional secret first-owner code. If omitted, read the generated code from the console. It is not a replacement for the owner password.                       |
| `ENCRYPTION_KEY`          | Optional 64-hex-character key. Omit to use the generated binary `encryption.key` file. Changing it without migrating data makes saved credentials unreadable. |
| `SERVER_NAME`             | Display name returned by server settings.                                                                                                                     |
| `REMOTE_ENABLED`          | Set `false` to disable phone pairing.                                                                                                                         |
| `MEDIA_DIR`               | Compose-only host media directory; must exist. It is mounted read-only at `/media`.                                                                           |
| `APP_HOST_PORT`           | Compose loopback port, default `4174`. Use a different port when a development server already occupies it. The app still listens on `4174` inside Docker. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Optional Compose connector token, stored only in your private `.env`. Do not paste it into screenshots or issue reports.                                      |

`YOUTUBE_ENABLED` defaults to `false` for native installs. The optional Compose `youtube` profile supplies the internal resolver; the default app image has no yt-dlp installed. See [resolver setup](../README.md#optional-youtube-resolver) for the commands and version pin. YouTube playback uses TesPlayer only and requires the resolver to be available.

No credentials are present in `.env.example`. Enter provider credentials through the protected app, not in frontend source files.

## Upgrading from the `aperture` Compose project

TesPlay 0.2.2 uses the `tesplay` Compose project name. Back up the database and encryption key, then run these commands from the updated TesPlay directory with your existing environment settings:

```sh
docker compose -p aperture --profile youtube --profile tunnel down
docker compose up -d --build app
```

Use the same `--env-file` on both commands if your installation uses a custom environment file. If `COMPOSE_PROJECT_NAME` is set, update it to `tesplay` before starting the new containers. Include `--profile youtube` or `--profile tunnel` on `docker compose up` for each optional service you use and omit the `app` service argument to start them alongside it. Keep the same `DATA_VOLUME_NAME` if you configured one. Compose reuses the existing named volume, which defaults to `aperture-data`.

## Reconnect expired YouTube authorization

If Google expires or revokes the saved authorization, subscriptions, playlists and the personal feed require another Google sign-in. TesPlay reports this as HTTP 409 with a reconnect message; it is not a resolver or server outage. Open **Connections**, find the existing YouTube connection, and choose **Reconnect Google**. Keep the existing connection so its starred channels, watch playlist and history continue to use the same ID. If the message instead identifies invalid OAuth client settings, correct the client ID and secret there before reconnecting.

Public video playback uses the separate optional resolver. A working resolver health check or a successful sample video resolution does not verify Google account authorization.

## Your public hostname and Cloudflare Access

This repository does not provision DNS, Cloudflare Access, a tunnel, or certificates. Replace `media.example.com` with your own hostname and configure your chosen access policy. Reuse an existing connector when possible; do not launch multiple replicas pointed at different data stores under one hostname.

For a native process:

1. Change `.env` to `PUBLIC_URL=https://media.example.com` and `TRUST_PROXY=1`.
2. Keep `HOST=127.0.0.1` and `PORT=4174`.
3. In the existing tunnel's published application route, use `http://127.0.0.1:4174` when its connector runs on the same host.
4. Start/restart the app with `node --env-file=.env server/index.js`.
5. Run the existing connector normally. If it has not been installed, install/configure it separately using the official [Cloudflare Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). No installer is run by this project.

For the optional Compose connector:

1. Use the same HTTPS `PUBLIC_URL` and `TRUST_PROXY=1` in `.env`.
2. Put the token for the intended remotely managed tunnel in `CLOUDFLARE_TUNNEL_TOKEN`. Keep `.env` mode `600`. The app container never receives this token.
3. The tunnel's route must use `http://app:4174` because `app` is its neighbor on the Compose network. Do not use `localhost` inside the connector container.
4. Retain the hostname's Access policy. This Compose file does not change it.
5. Start the optional profile:

```sh
docker compose --profile tunnel up -d --build
# Add --profile youtube before up to enable the optional YouTube resolver.
docker compose logs app
```

`cloudflared` receives its token through the documented `TUNNEL_TOKEN` environment variable. Native installations can instead use `cloudflared tunnel --no-autoupdate run --token-file /absolute/private/path/tunnel-token` with a protected token file; `--token-file` requires cloudflared 2025.4.0 or later. See [official run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/). The default image tag is `latest`; set `CLOUDFLARED_IMAGE` to a version or digest you have validated when you want reproducible updates.

Visit the HTTPS hostname, complete any configured access-gateway login, and then sign in or create the TesPlay owner with the console setup code. Once `PUBLIC_URL` is HTTPS, use the HTTPS URL for authenticated browsing: an ordinary HTTP origin cannot send its secure session cookie. `/api/health` remains available locally for process checks.

Keep API responses, playlists, protected artwork and media paths out of any custom public cache rules. When troubleshooting, determine whether an error page came from Access, the app or the upstream provider before changing anything. Do not disable Access to fix an OAuth or playback issue.

## Google Drive OAuth

Drive needs an OAuth **Web application** client that belongs to your Google Cloud project. Enable the Drive API, configure the consent screen/audience for your account, and add your account as a test user when the consent app is in testing.

Set this exact authorized redirect URI for public use:

```text
https://media.example.com/api/drive/callback
```

For local-only testing, use the exact local `PUBLIC_URL` plus `/api/drive/callback` instead; it is a separate authorized redirect URI. The origin used to start authorization must match the origin of the callback so the owner session can be checked.

In TesPlay, add Drive with `clientId`, `clientSecret` and optional `folderId`, then choose its Google authorization action. Accept the read-only Drive consent on Google's own page. Tokens and the client secret are saved encrypted on the host. This uses `drive.readonly`, which can read the account's Drive files; a folder ID narrows the app's browsing, not the scope of Google's grant. Google's scope classification and applicable verification/audience limits still apply. See [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [web-server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server).

Authorize from a browser that has completed TesPlay sign-in and any configured access-gateway login. The callback is a browser redirect, not a Google server webhook, so the existing Access layer can remain in place. If consent is revoked or a refresh token expires, reconnect using the same setup. Docs and Google-native files are not converted into playable video.

## Plex and network files

Plex authorization uses a PIN approved on Plex's site. After approval, pick a discovered server address that **the TesPlay host** can reach. A local LAN address is suitable even when the Tesla is on cellular, since TesPlay relays playback. A cloud metadata address or loopback URL is intentionally rejected. Do not disable TLS validation for a server with a bad certificate; use its correct address/certificate.

Choose the Plex Home profile separately from the TesPlay household profile. A protected Plex profile requires its PIN. Profile-specific Plex tokens are associated with the selected TesPlay profile. Real Plex account/server testing remains necessary, including managed users and any Plex-side transcoding requirements.

For SMB, mount the share with the host operating system. Add its local mount point to TesPlay, or configure `MEDIA_DIR` so Docker exposes that folder at `/media`. The server must be able to list/read it, and the mount must survive host restarts. No SMB username/password is requested by the app. Missing mounts can look like empty libraries; check the OS mount before changing app credentials.

## Reset a forgotten password

Household members' passwords are reset by the owner in **Settings → Household accounts**. To reset any account's password from the server, including the owner's, run the reset script where TesPlay's data lives:

```sh
docker exec -it tesplay node scripts/reset-password.mjs <username or email>
```

It prints a new generated password once and signs that account out on every device. To choose the password yourself, pipe it in with `--stdin` (for example `printf '%s' 'new password' | docker exec -i tesplay node scripts/reset-password.mjs <username> --stdin`); it needs at least 12 characters. For a native installation, run `node scripts/reset-password.mjs <username>` with `DATA_DIR` set to TesPlay's data folder.

## Backups and moving hosts

Use `scripts/backup.mjs` rather than copying a live SQLite file alone: recent transactions may be in its WAL file. The helper uses SQLite `VACUUM INTO` and saves the matching encryption key. It does not copy media files, OS mount credentials, Cloudflare connector credentials or `.env`.

For Docker, create the consistent snapshot within the persistent volume, then copy it to your private backup location:

```sh
docker compose exec app node scripts/backup.mjs /app/data /app/data/backups
mkdir -p backups
docker compose cp app:/app/data/backups/. ./backups/
chmod -R go-rwx backups
```

Copy the completed backup off the host to storage you control. If you supplied `ENCRYPTION_KEY`, the helper records it in `encryption-key.hex`; otherwise it includes `encryption.key`. Backups contain sensitive data even though the database itself encrypts connection configuration.

To restore:

1. Stop the app and connector before replacing data. Preserve the previous data directory/volume so you can roll back.
2. Restore the snapshot's `aperture.sqlite` into an **empty** data directory, together with `encryption.key`. If `backup.json` says `environment`, restore `encryption-key.hex` as the exact `ENCRYPTION_KEY` value in the private environment instead.
3. Do not combine the restored database with old `aperture.sqlite-wal` or `aperture.sqlite-shm` files. The snapshot is self-contained.
4. Make restored directories/files readable and writable by the service user only. The Docker image uses the `node` account (UID 1000); ensure restored volume ownership is correct before starting it.
5. Carry over the required `.env` settings, use the new host's media mount paths, and point the existing connector at that host.
6. Start the app and verify login, saved connections and playback. A restored active session may still be valid; normal expiry continues.

Keep the old service stopped once the new one serves the hostname. Two live SQLite installations behind the same tunnel would have different sessions and library state.

## Acceptance check

### Browser console and Cloudflare Access

Production sends a fresh CSP nonce for each HTML response, allows Cloudflare's analytics beacon, and permits TesPlayer's generated blob worker/worklet scripts. Arbitrary inline scripts remain blocked. Cloudflare JavaScript Detections can read the nonce from the CSP header when injecting its own script. Keep the application's CSP response header intact rather than adding a second, more restrictive policy in Cloudflare.

TesPlay API and player requests send `X-Requested-With: XMLHttpRequest`. Cloudflare Access uses this header to return HTTP 401 for an expired session instead of redirecting an API request to its cross-origin login page. Reload the screen when prompted to authenticate again. This does not change Access policies, the identity provider or session duration. See [Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) and [JavaScript Detections with CSP](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/).

Unavailable provider artwork receives a neutral placeholder cached privately for five minutes. If a provider's image hostname no longer resolves, request updated artwork URLs from that provider; changing Cloudflare CORS settings will not restore those images.

Use your own authorized accounts to check a new installation. See the [maintainer-tested vehicles](compatibility.md) for reported hardware results; verify your own provider and network configuration separately.

- Restart the app and confirm the owner, connections, lists and progress survive.
- Through the protected HTTPS address, verify Access then TesPlay login on the phone and the parked Tesla.
- Play a known browser-compatible local file; seek forward and resume after reopening it.
- Play one Xtream live channel, one VOD film and one series episode; inspect EPG where the provider supplies it.
- Approve Plex, choose the correct server, test an ordinary and a protected Home profile, and verify their libraries differ as expected.
- Authorize Drive, browse the configured folder and play an owned compatible media file.
- Pair the phone under the same owner account; test play/pause, seeking and volume.
- Test the intended MCU/browser and cellular connection. A 2026 Model 3 result does not certify older MCU1/MCU2 cars or a different firmware version.

Use the browser's normal fullscreen controls while parked. Firmware determines how much system UI can be hidden. The app cannot reliably infer gear from a regular web page; it does not claim a vehicle safety interlock.

## YouTube OAuth and phone QR setup

YouTube supports a saved Data API key or an OAuth web client with the YouTube Data API enabled. Register `https://media.example.com/api/youtube/callback` alongside the separate Drive callback when using the same Google Cloud project. Save the client ID and secret in TesPlay account settings, select Google OAuth and authorize on your phone. Offline tokens are encrypted and refreshed server-side. Google may still require fresh consent after revocation, token expiry, client changes or OAuth testing-mode limits. See [Google’s YouTube OAuth guide](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps).

Open YouTube from the main navigation for subscriptions, channel uploads, playlists, search and profile-specific watch history. Edit your existing YouTube connection and choose Google OAuth to unlock account subscriptions and private playlists; a Data API key can only browse public content. Both channel and subscription lists have pagination. The suggestions feed draws from subscriptions, includes only starred subscriptions and orders uploads newest first. Google's Data API does not expose account watch history or the YouTube Home feed; the history displayed here records watches inside TesPlay. See [subscriptions authorization](https://developers.google.com/youtube/v3/docs/subscriptions/list) and [YouTube API changes](https://developers.google.com/youtube/v3/revision_history). For the real Home feed and account history use the InnerTube mode below.

## YouTube: sign in on this screen (InnerTube)

The **Sign in on this screen** mode signs the TesPlay server in to YouTube's InnerTube API (the API the YouTube TV app uses) with the `youtubei.js` client. No redirect URL or `PUBLIC_URL` is involved: TesPlay requests a device code, shows the short user code plus `google.com/device` (also as a QR code), and polls until the code is approved on your phone.

By default the sign-in uses the OAuth client of YouTube's own TV app: `youtubei.js` reads its ID and secret from `youtube.com/tv`, the device code and token requests go to `youtube.com/o/oauth2/*` with the TV scope (`http://gdata.youtube.com`), and the client identity is remembered encrypted on the connection (`tvBuiltinClientId`, `tvBuiltinClientSecret`) so refreshes do not depend on youtube.com/tv staying parseable. YouTube can change or block this at any time; that is the trade-off every third-party TV sign-in makes. To use your own client instead, create one of type **TVs and Limited Input devices** in a Google Cloud project with the YouTube Data API v3 enabled and set `GOOGLE_TV_CLIENT_ID` / `GOOGLE_TV_CLIENT_SECRET` for the installation (Compose passes both through) or save it per connection (`tvClientId`, `tvClientSecret`); such a client goes through Google's documented `oauth2.googleapis.com` device endpoints, requesting the TV scope first and `https://www.googleapis.com/auth/youtube` if Google refuses it. Device-flow tokens are stored encrypted in the connection like the web-client tokens (`tvAccessToken`, `tvRefreshToken`, `tvExpiresAt`) and refreshed server-side; changing your client ID or secret clears them.

What it gives: a **Home** tab with the account's recommendations, **Latest** (newest uploads across all subscriptions), the subscription channel list, the account's **watch history** (newest first), quota-free search with channel matches, channel uploads and playlist contents (including Watch later `WL` and Liked videos `LL`), all paginated. YouTube only honours the TV app's token on requests made as the TV client, and those answers are built from the TV app's `tileRenderer` nodes rather than the web layouts `youtubei.js` parses, so the server reads them directly and pages with the TV continuation tokens. Only the connection owner can start or cancel the sign-in or sign out; shared users browse with the owner's account.

Playback resolves streams through InnerTube first: the signed-in TV client when the connection is signed in, declaring an older TV app version (5.x, the one yt-dlp calls `tv_downgraded`) for the player request, because the current TV versions (7.x) are answered with server-ABR-only streaming data and no plain URLs (as of November 2026); then an anonymous visionOS client (the client yt-dlp uses) carrying visitor data minted by a plain page view of youtube.com; without that visitor data every anonymous InnerTube client answers “Sign in to confirm you’re not a bot”. It picks the best H.264 (`avc1`) video track at or below 1080p plus AAC audio (itag 140), for the anonymous client reads a slice from the middle of each file to confirm the host serves more than the first megabyte (clients that need a proof-of-origin token stop there; the signed-in TV client's URLs serve any range and skip the check), and registers both through the media proxy as a dual-input source. googlevideo refuses open-ended and multi-megabyte range requests, while TesPlayer asks for `bytes=N-`, so the proxy re-chunks each client range into 4 MiB upstream requests. To shorten the start, the proxy fetches the first 2 MiB of video and 512 KiB of audio as soon as it hands out the links, so the player's opening reads come from memory over an already open connection; resolved links are remembered for up to 30 minutes (well inside their expiry) so reopening or resuming a video skips the player request, and are dropped when googlevideo refuses them; and the signed-in player client is prepared when the YouTube Home tab loads. A live broadcast on a signed-in connection comes back from the same older TV client as one plain URL per track that serves a numbered 5-second segment (`&sq=N`), each a complete fragmented MP4; the newest segment and the head sequence number (`X-Head-Seqnum`) come back without `sq`. The server relays the H.264 and AAC tracks as two growing fragmented-MP4 streams, starting both at the same segment two behind the live edge, keeping the first segment's header and appending only the fragments of the following ones, and renewing the URLs through the player request when they expire; TesPlayer reads the pair as a live dual input. The relay holds nothing on disk. Live broadcasts without sign-in, upcoming streams, SABR-only responses and anything InnerTube refuses fall back to the yt-dlp resolver when it is enabled. YouTube changes these rules often, so keep the yt-dlp profile available as the fallback.

## Car mode: a GPU transcoder for live channels

Live IPTV in 1080p or at 60 fps can be too much for a car browser to decode smoothly, and too heavy for mobile data. Car mode converts a live channel to H.264 at up to 720p and 30 fps with stereo AAC, about 3 Mbps. The conversion runs in a separate transcoder service (`Dockerfile.transcoder`, `server/transcoder-service.js`), ideally on a machine with an Intel GPU such as a mini PC. TesPlay posts the channel's address to it; the transcoder opens the provider stream itself and streams the result back, so the provider sees the transcoder's internet connection.

On the transcoder machine, pass the GPU's render device into the container and give the container that device's group (`stat -c %g /dev/dri/renderD128` prints it):

```yaml
services:
  transcoder:
    build:
      context: https://github.com/forrestpowers/TesPlay.git
      dockerfile: Dockerfile.transcoder
    image: tesplay-transcoder:local
    pull_policy: never
    restart: unless-stopped
    init: true
    devices:
      - /dev/dri/renderD128:/dev/dri/renderD128
    group_add:
      - "${RENDER_GID}"
    environment:
      TRANSCODER_TOKEN: ${TRANSCODER_TOKEN}
    ports:
      - "4190:4190"
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
```

At startup the transcoder tries the GPU encoder, then the GPU's low-power encoder (the only one on some Intel chips, such as the N97), then software encoding, and logs which one it uses. `GET /health` reports it. Optional settings: `TRANSCODE_LIMIT` (simultaneous channels, default 3), `TRANSCODE_HEIGHT` (default size when a request names none, 720), `TRANSCODE_FPS` (default 30), `TRANSCODE_VIDEO_KBPS` (default 3000), `TRANSCODE_PREBUFFER_MS` (output held back at the start so the player begins a few seconds ahead of the live stream, which prevents audio crackling; default 3000, 0 turns it off), `TRANSCODER_ENCODER` (`auto`, `vaapi`, `vaapi-lp` or `software`) and `TRANSCODER_ALLOWED_PRIVATE_HOSTS` (provider hosts on a private network; refused by default).

Make the transcoder reachable from TesPlay, for example as a Pangolin resource on an existing Newt site that points at the machine's LAN address and port 4190. TesPlay calls it server to server, so that resource cannot require the Pangolin login; the token protects it instead, and a rule that allows only the TesPlay server's address adds a second check. Then set `TRANSCODER_URL` (for example `https://transcode.example.com`) and the same `TRANSCODER_TOKEN` on TesPlay and rebuild it.

When TesPlay runs on the same server as Pangolin, it may not be able to reach that server's own public address from inside its container; car mode then reports that TesPlay cannot reach the transcoder. Set `TRANSCODER_CONNECT_HOST` to the Pangolin container that serves HTTPS on the Docker network TesPlay shares with it (`gerbil` in a standard Pangolin install, where Traefik runs inside Gerbil's network). TesPlay then connects there directly while still using the transcoder's hostname for HTTPS.

With both set, live Xtream channels and M3U channels with continuous `.ts` addresses show **Car mode** in the player settings: **Off**, **720p** (about 3 Mbps) or **480p** (about 1.3 Mbps, for weak mobile signal). Both sizes run at 30 fps; the bitrate scales with the picture area from `TRANSCODE_VIDEO_KBPS`. Each account can set a default in **Settings → Playback → Car mode for live TV** (Off, 720p or 480p), stored on the server so it follows the account to every device; new live channels start with it. A choice made in the player applies to that channel only: switching channel, or closing and reopening the player, returns to the default. Without a transcoder configured, a car-mode request plays the channel normally.

## IPTV movies and series

Most IPTV providers deliver their movies and series as H.265 (HEVC), which the Tesla browser cannot decode without transcoding, so TesPlay offers IPTV live channels only. Movies and series are left out of category setup, Home, the IPTV library and household sharing, and the Series and Movies tabs appear only when another connected library (Google Drive, or an existing Plex or Stremio connection) can fill them. Set `IPTV_ON_DEMAND=1` to offer IPTV movies and series again.

## YouTube from a datacenter address (proof-of-origin tokens)

From a datacenter or VPS address (Oracle, Hetzner and the like), YouTube answers anonymous InnerTube player requests with “Sign in to confirm you’re not a bot” even with visitor data, and yt-dlp gets the same answer, so playback fails while signed-in browsing keeps working. The optional `pot` Compose profile runs [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider), which mints proof-of-origin tokens with BotGuard. Set `YOUTUBE_POT_PROVIDER_URL=http://pot:4416` and start with `--profile pot`; the app asks it for a token bound to its visitor data (`POST /get_pot`), passes the token to `youtubei.js` (player request and `pot=` on every stream URL) and also tries the web clients, which only hand out plain URLs once a token is attached. The yt-dlp resolver image installs the matching `bgutil-ytdlp-pot-provider` plugin and is pointed at the same server through `--extractor-args youtubepot-bgutilhttp:base_url=…`. Tokens are cached for up to five hours per visitor data and renewed with it. The provider has no authentication, so keep it off any published port. A token helps with throttled slices, but YouTube can still refuse some addresses outright: on an Oracle Cloud address (November 2026) the visionOS player request kept answering “Sign in to confirm you’re not a bot” with a valid token attached, and the yt-dlp fallback got the same answer. The signed-in account is what helps here: YouTube accepts the TV app's token only on TV-client requests (every other client answers HTTP 400 when authenticated), and a signed-in player request as the older TV client version gets plain stream URLs bound to the server's address, which googlevideo serves by byte range from datacenter addresses too. Signed-in browsing works from any address, and so does playback; SABR, described next, is the fallback should the older TV version stop getting plain URLs.

## YouTube SABR playback (signed-in, any address)

When a connection is signed in and the plain stream paths fail, TesPlay plays through YouTube's server-side adaptive streaming, the protocol the TV app itself uses, with the [googlevideo](https://github.com/LuanRT/googlevideo) client. The server opens a SABR session for the signed-in TV client, picks the H.264 track the TV app would on a car (30 fps before 60 fps, then the tallest at or below the ceiling, 720p by default; `YOUTUBE_MAX_HEIGHT=1080` raises it, and the same ceiling applies to the plain stream paths) and the original stereo AAC soundtrack (itag 140), and spools both tracks into `DATA_DIR/youtube-cache` as fragmented MP4 while they download (a 30-minute 1080p video arrives in under a minute at YouTube's delivery rate). Each track's `sidx` index gives the byte range and duration of every segment, so the media proxy serves the tracks by byte range with their full length from the first kilobytes on: TesPlayer plays them as an ordinary dual input with instant seeking and a known duration. A range that has not arrived yet waits for the stream, and a request far from where the stream is restarts it at that time (the engine reads the end of each file while inspecting it, so the tails are fetched once up front). One session per video is shared by every reader and kept for two hours after its last use, with at most four sessions at once; the folder is emptied on start. Live broadcasts use the segment relay described above. `YOUTUBE_SABR=off` disables it; `auto` (default) uses it after every plain path fails; `prefer` uses it as soon as the signed-in TV player path fails, before the anonymous clients are tried (useful where those always fail, such as on datacenter addresses). The signed-in TV player path, with plain URLs and no spooling, comes first in every mode. YouTube's player script runs inside a bare V8 context (`node:vm`) to decipher the streaming URL; no other code from YouTube is executed.

QR login and setup must use the phone-reachable `PUBLIC_URL`. Localhost QR codes work only on the host computer; the UI explains this. Cloudflare Access and TesPlay login remain separate checks. Every login QR has a five-minute lifetime, explicit confirmation on an authenticated phone, and redemption restricted to the browser that created it. QR images are generated locally.

## Usernames and phone content selection

New accounts use a username (3–40 letters/numbers/dots/underscores/hyphens) and password; email is not required and no email service is implied. Existing installations receive unique usernames derived from their existing email names, while their original email/password sign-in remains valid. The migration preserves user IDs, passwords, profiles, sessions, encrypted connections and sharing grants.

Scan the screen’s remote QR from any phone browser; no TesPlay username/password is required. The five-minute, single-use QR grants remote access to that screen and profile. The remote cannot manage accounts, connections, or other browser authorizations. A browser already signed into the same account can select an available screen directly without a QR; when exactly one screen is online it connects automatically. The screen’s profile is selected for the remote, and its assignment is remembered across page and server restarts. Use **Use as browser** on an account-authorized remote to return to ordinary browsing.

Settings → **Authorized browsers** lists the account’s browsers in a compact table, with role, last activity, and a removal action. Removing the current browser signs it out. Removing a screen also revokes the guest remote sessions authorized through its QR codes. Separate account logins keep their account access, while the removed screen becomes unavailable. Existing full sign-in/setup QR codes still require explicit approval on an account-authorized browser. The existing outer Cloudflare Access policy remains in place.

 Tap Enable playback on the screen if this browser needs a sound gesture. On the phone, choose Browse content for this screen, then use any permitted library and select a video. The connected banner provides the controls and Disconnect actions. Each screen has its own room and playback instance.

The application no longer opens device file pickers for subtitles or M3U imports. Paste VTT/SRT text in player settings, or paste M3U content in Connections (playlist URLs are also supported). A browser-managed local-file warning cannot be dismissed or its administrator policy changed by a website.

## Normal Tesla browser visibility

Tesla-identified browsers use a smaller decoded-video queue (8 frames instead of 24) and a shorter audio/lookahead buffer to reduce memory retained while the camera or another app is visible. This preserves the media engine and audio behavior; minimizing does not navigate, reload, sign out, or destroy the player. On page/visibility restoration, an open player dialog is shown again if the browser dropped its native dialog state. The HTML shell also displays TesPlay and a reload link if startup JavaScript cannot load.

The normal-browser blank-page report has not been reproduced in an actual Tesla. These changes reduce graphics memory pressure and handle native-dialog restoration; they do not establish the original cause. Vehicle firmware can terminate or replace a browser process, which a website cannot prevent. Verify minimizing and returning from the reverse camera in the actual car and record whether its address bar retains the TesPlay URL.
