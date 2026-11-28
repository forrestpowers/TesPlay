// YouTube through InnerTube (the API YouTube's own apps use) with the youtubei.js
// client, signed in with Google's device-code flow for "TVs and Limited Input
// devices". The user types a short code at google.com/device on any phone, so no
// typing or redirect happens on the car screen. Browsing (Home, subscriptions,
// history, search, channels, playlists) carries the account; stream resolution
// prefers the signed-in TV client, then the anonymous iOS client, and the caller
// falls back to yt-dlp when neither yields plain videoplayback URLs.
import { createHash, randomBytes } from 'node:crypto';
import https from 'node:https';
import vm from 'node:vm';
import { providerError, validateRemoteUrl } from './media.js';
import { plainText } from './text.js';
import { createLiveSession } from './youtube-live.js';

// Google's documented endpoints for a client you create yourself ("TVs and Limited Input devices").
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
// The endpoints YouTube's own TV app uses with its built-in client (what youtubei.js and sites like gigaplay use).
const YT_DEVICE_CODE_URL = 'https://www.youtube.com/o/oauth2/device/code';
const YT_TOKEN_URL = 'https://www.youtube.com/o/oauth2/token';
const YT_REVOKE_URL = 'https://www.youtube.com/o/oauth2/revoke';
// YouTube's TV app requests the legacy YouTube scope, which InnerTube expects on a
// Bearer token. Google rejects it for some custom clients; the Data API scope is
// the documented alternative for a TV-type client.
export const TV_SCOPES = ['http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content', 'https://www.googleapis.com/auth/youtube'];
// The TV client version YouTube still answers with plain stream URLs when signed in. Current TV
// versions (7.x) get server-ABR-only streaming data; yt-dlp calls this older one "tv_downgraded".
export const TV_PLAYER_CLIENT = { clientVersion: '5.20260707', userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version' };
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/, CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/, PLAYLIST_ID = /^(?:WL|LL|[A-Za-z0-9_-]{10,100})$/; // WL = Watch later, LL = Liked videos
const SHORT_TYPES = new Set(['ReelItem', 'ShortsLockupView']);
const text = value => plainText(value == null ? '' : typeof value === 'string' ? value : typeof value.text === 'string' ? value.text : typeof value.toString === 'function' ? value.toString() : '').trim();

/** Every YouTube connection signs in with the phone (InnerTube); the Data API key and web sign-in are gone. */
export function isInnertubeMode(c) { return c?.type === 'youtube' || c?.config?.authMode === 'innertube'; }
export function innertubeSignedIn(c) { return isInnertubeMode(c) && typeof c.config.tvRefreshToken === 'string' && c.config.tvRefreshToken.length > 0; }
export const SIGN_IN_REQUIRED = 'Sign in with Google on this screen from YouTube settings to see your Home feed, subscriptions and history.';
export const RECONNECT_REQUIRED = 'Google authorization for YouTube has expired or was revoked. Open Connections and sign in on this screen again.';

/** "3 days ago" style text to an ISO date, so feeds sort newest first. */
export function relativeDate(value, now = Date.now()) {
  const match = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(String(value || ''));
  if (!match) return undefined;
  const units = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000 };
  return new Date(now - Number(match[1]) * units[match[2].toLowerCase()]).toISOString();
}
/** "1:02:03" / "12:34" to seconds. */
export function clockDuration(value) {
  const parts = String(value || '').trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some(p => !/^\d{1,2}$/.test(p))) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return seconds > 0 ? seconds : undefined;
}
function thumbnailUrl(list) {
  const best = (Array.isArray(list) ? list : []).filter(t => typeof t?.url === 'string').sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  if (!best) return undefined;
  const url = best.url.startsWith('//') ? `https:${best.url}` : best.url;
  try { const u = validateRemoteUrl(url); return u.protocol === 'https:' ? u.href : undefined; } catch { return undefined; }
}
const runEndpointId = (t, key) => { for (const run of [...(t?.runs || []), t]) { const id = run?.endpoint?.payload?.[key]; if (id) return id; } return undefined; };
function lockupParts(node) {
  const rows = node?.metadata?.metadata?.metadata_rows || [];
  return rows.flatMap(row => (row.metadata_parts || []).map(part => part.text).filter(Boolean));
}
function overlayBadges(node) {
  const overlays = node?.content_image?.overlays || node?.header?.thumbnail_overlays || [];
  return overlays.flatMap(o => (o.badges || []).map(b => text(b.text)).concat(o.text ? [text(o.text)] : []));
}
/** Text lines of a TV-app Tile: ["Channel name", "9.7K views", "3 days ago", ...]. */
const tileLines = node => (node?.metadata?.lines || []).flatMap(line => (line.items || []).map(item => text(item.text)).filter(Boolean));
const tileType = node => String(node?.content_type || '').replace(/^TILE_CONTENT_TYPE_/, '');
/** Convert any youtubei.js video-like node into TesPlay's MediaItem shape (without proxied artwork). */
export function videoItem(node, { connectionId, channel } = {}, now = Date.now()) {
  if (!node || typeof node !== 'object') return null;
  const type = node.type;
  const id = [node.video_id, node.content_id, node.id, node.endpoint?.payload?.videoId, node.on_tap_endpoint?.payload?.videoId].find(v => VIDEO_ID.test(String(v || '')));
  if (!id) return null;
  if (type === 'LockupView' && !['VIDEO', 'SHORT', 'UNSPECIFIED', undefined].includes(node.content_type)) return null;
  if (type === 'Tile' && !['VIDEO', 'SHORT', 'SHORTS', ''].includes(tileType(node))) return null;
  const title = text(node.title ?? node.metadata?.title ?? node.overlay_metadata?.primary_text ?? node.accessibility_text);
  if (!title || ['Private video', 'Deleted video', '[Private video]', '[Deleted video]'].includes(title)) return null;
  const parts = lockupParts(node);
  const lines = type === 'Tile' ? tileLines(node) : [];
  const author = node.author?.name ? text(node.author.name) : text(parts.find(t => runEndpointId(t, 'browseId'))) || (lines.length && !/\b(views|watching|ago)\b/i.test(lines[0]) ? lines[0] : '') || channel?.title || '';
  const channelId = [node.author?.id, ...parts.map(t => runEndpointId(t, 'browseId')), channel?.id].find(v => CHANNEL_ID.test(String(v || '')));
  const durationValue = node.duration?.seconds ?? (typeof node.duration === 'object' && node.duration ? clockDuration(text(node.duration)) : typeof node.duration === 'number' ? node.duration : undefined) ?? clockDuration(text(node.length_text)) ?? overlayBadges(node).map(clockDuration).find(Boolean);
  const publishedText = text(node.published) || [...parts.map(text), ...lines].find(t => /\bago\b/i.test(t)) || '';
  const live = node.is_live === true || overlayBadges(node).some(t => /^LIVE$/i.test(t)) || /^(Streamed|Live)/i.test(publishedText) && !durationValue;
  const short = SHORT_TYPES.has(type) || node.content_type === 'SHORT' || tileType(node) === 'SHORTS';
  const thumbnails = node.thumbnails || node.content_image?.image || node.content_image?.primary_thumbnail?.image || node.thumbnail?.image || node.header?.thumbnail || [];
  return {
    id, connectionId, source: 'YouTube', providerType: 'youtube', type: 'video', title,
    ...(text(node.description_snippet || node.description) ? { description: text(node.description_snippet || node.description) } : {}),
    poster: thumbnailUrl(thumbnails) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    ...(author ? { subtitle: author, categoryLabel: author } : {}),
    ...(channelId ? { channelId } : {}),
    ...(durationValue && durationValue <= 604800 ? { duration: durationValue } : {}),
    ...(relativeDate(publishedText, now) ? { publishedAt: relativeDate(publishedText, now) } : {}),
    ...(short ? { contentKind: 'short' } : live ? { contentKind: 'live' } : {}),
  };
}
export function channelItem(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'LockupView' && node.content_type !== 'CHANNEL') return null;
  if (node.type === 'Tile' && tileType(node) !== 'CHANNEL') return null;
  const id = [node.author?.id, node.content_id, node.id, node.endpoint?.payload?.browseId].find(v => CHANNEL_ID.test(String(v || '')));
  if (!id) return null;
  const title = text(node.author?.name ?? node.title ?? node.metadata?.title);
  if (!title) return null;
  const parts = [...lockupParts(node).map(text), ...tileLines(node)];
  const count = text(node.video_count) || text(node.subscriber_count) || parts.find(t => /subscriber|video/i.test(t)) || '';
  const videoCount = /(\d[\d,.]*)\s*videos?/i.exec(count) ? Number(/(\d[\d,.]*)\s*videos?/i.exec(count)[1].replace(/[,.]/g, '')) : undefined;
  const thumbnails = node.author?.thumbnails || node.thumbnails || node.content_image?.image || node.content_image?.avatar?.image || node.content_image?.primary_thumbnail?.image || node.header?.thumbnail || [];
  return { id, title, description: text(node.description_snippet), thumbnail: thumbnailUrl(thumbnails), ...(videoCount ? { videoCount } : {}), ...(count ? { subtitle: count } : {}) };
}
export function playlistItem(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'LockupView' && !['PLAYLIST', 'PODCAST', 'ALBUM', 'COURSE'].includes(node.content_type)) return null;
  if (node.type === 'Tile' && tileType(node) !== 'PLAYLIST') return null;
  const id = [node.id, node.content_id, node.endpoint?.payload?.playlistId].find(v => PLAYLIST_ID.test(String(v || '')) && !VIDEO_ID.test(String(v || '')));
  if (!id) return null;
  const title = text(node.title ?? node.metadata?.title);
  if (!title) return null;
  const countText = text(node.video_count ?? node.video_count_short) || overlayBadges(node).find(t => /video|episode|lesson/i.test(t)) || [...lockupParts(node).map(text), ...tileLines(node)].find(t => /video|episode/i.test(t)) || '';
  const match = /(\d[\d,.]*)/.exec(countText);
  const thumbnails = node.thumbnails || node.content_image?.primary_thumbnail?.image || node.content_image?.image || node.header?.thumbnail || [];
  return { id, title, thumbnail: thumbnailUrl(thumbnails), videoCount: match ? Number(match[1].replace(/[,.]/g, '')) : 0 };
}
const uniqueBy = (items, key) => [...new Map(items.filter(Boolean).map(i => [i[key], i])).values()];
/** Video nodes of a feed: the web-style nodes youtubei.js collects plus the TV app's Tile nodes. */
export const feedNodes = (feed, kind = 'videos') => [...(feed?.[kind] || []), ...(feed?.memo?.get?.('Tile') || [])];
export const feedVideos = (feed, context, now) => uniqueBy(feedNodes(feed).map(n => videoItem(n, context, now)), 'id');

/** Every value stored under `key` anywhere in a raw InnerTube response. */
export function rawFind(data, key, depth = 0, acc = []) {
  if (depth > 60 || data == null || typeof data !== 'object') return acc;
  if (Array.isArray(data)) { for (const item of data) rawFind(item, key, depth + 1, acc); return acc; }
  for (const [name, value] of Object.entries(data)) { if (name === key) acc.push(value); rawFind(value, key, depth + 1, acc); }
  return acc;
}
const rawText = value => value?.simpleText ?? (Array.isArray(value?.runs) ? value.runs.map(run => run.text).join('') : '');
/** The TV app's tileRenderer as the Tile shape the item mappers understand. */
export function rawTileNode(tile) {
  const header = tile?.header?.tileHeaderRenderer || {};
  const metadata = tile?.metadata?.tileMetadataRenderer || {};
  return {
    type: 'Tile', content_id: tile?.contentId, content_type: tile?.contentType,
    header: {
      thumbnail: header.thumbnail?.thumbnails || [],
      thumbnail_overlays: (header.thumbnailOverlays || []).map(overlay => overlay.thumbnailOverlayTimeStatusRenderer ? { text: rawText(overlay.thumbnailOverlayTimeStatusRenderer.text), style: overlay.thumbnailOverlayTimeStatusRenderer.style } : {}),
    },
    metadata: { title: { text: rawText(metadata.title) }, lines: (metadata.lines || []).map(line => ({ items: (line.lineRenderer?.items || []).map(item => ({ text: { text: rawText(item.lineItemRenderer?.text) } })) })) },
  };
}
/** Tiles and the next continuation token of a raw TV browse response. */
export function rawTvPage(data) {
  const tiles = rawFind(data, 'tileRenderer').map(rawTileNode);
  const continuation = rawFind(data, 'continuationCommand').map(c => c?.token).find(Boolean) || rawFind(data, 'nextContinuationData').map(c => c?.continuation).find(Boolean) || null;
  return { tiles, continuation: typeof continuation === 'string' && continuation.length < 4096 ? continuation : null };
}

/** Picture heights a viewer can ask for. YouTube offers H.264 up to 1080p; taller sizes are VP9 or AV1 only. */
export const YOUTUBE_HEIGHTS = [1080, 720, 480, 360, 240, 144];
/** A requested height, or undefined for the server's automatic choice. */
export function youtubeHeight(value) {
  const height = Number(value);
  return YOUTUBE_HEIGHTS.includes(height) ? height : undefined;
}
const fps = f => f.fps || 30;
/**
 * Pick the H.264 video track. Automatic is like the YouTube TV app on a car screen: 30 fps
 * tracks before 60 fps ones (half the decode work on the Tesla's MCU), then the tallest at or
 * below the ceiling. A chosen height plays that height when the video has it (at 60 fps when
 * that is all it offers), otherwise the tallest below it.
 */
export function pickVideo(videos, { maxHeight = 1080, height } = {}) {
  const rank = (a, b) => Number(fps(a) > 31) - Number(fps(b) > 31) || (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0);
  if (height) {
    const exact = videos.filter(f => f.height === height).sort(rank)[0];
    if (exact) return exact;
    maxHeight = height;
  }
  return videos.filter(f => (f.height || 0) <= maxHeight).sort(rank)[0];
}
/** The H.264 sizes a video offers, tallest first, with the frame rate each would play at. */
export function videoQualities(videos) {
  const byHeight = new Map();
  for (const f of videos) {
    if (!YOUTUBE_HEIGHTS.includes(f.height)) continue;
    const known = byHeight.get(f.height);
    // The player plays the 30 fps track of a height when there is one.
    if (!known || (known > 31 && fps(f) <= 31)) byHeight.set(f.height, fps(f));
  }
  return [...byHeight].sort((a, b) => b[0] - a[0]).map(([height, rate]) => ({ height, fps: rate > 31 ? 60 : 30 }));
}
const describe = video => ({ height: video.height || null, fps: fps(video) > 31 ? 60 : 30 });

/** Choose a progressive H.264 video stream (see pickVideo) plus an AAC audio stream. */
export function chooseStreams(streamingData, { maxHeight = 1080, height } = {}) {
  const formats = [...(streamingData?.adaptive_formats || []), ...(streamingData?.formats || [])].filter(f => f && typeof f.mime_type === 'string' && !f.drm_families?.length && !f.is_type_otf);
  const h264 = formats.filter(f => f.has_video && !f.has_audio && /avc1/i.test(f.mime_type) && (f.url || f.signature_cipher || f.cipher));
  const video = pickVideo(h264, { maxHeight, height });
  // Videos with dubs carry several AAC tracks; the original language comes first, then the
  // track YouTube marks default, never auto-dubbed, described or DRC variants.
  const audios = formats.filter(f => f.has_audio && !f.has_video && /mp4a/i.test(f.mime_type) && (f.url || f.signature_cipher || f.cipher) && !f.is_descriptive && !f.is_auto_dubbed && (f.audio_channels || 2) <= 2)
    .sort((a, b) => audioRank(a) - audioRank(b) || processed(a) - processed(b) || (b.bitrate || 0) - (a.bitrate || 0));
  return video && audios[0] ? { video, audio: audios[0], qualities: videoQualities(h264) } : null;
}
/** YouTube lists each soundtrack three times: plain, with dynamic range compression and with voice boost. Plain sounds best. */
export const processed = format => ((format.is_drc ?? format.isDrc) ? 1 : 0) + ((format.is_vb ?? format.isVb) ? 1 : 0);
/** Lower is better: the original soundtrack, then the default track, then anything that is not a dub. */
export function audioRank(format) {
  const original = format.is_original ?? format.isOriginal;
  const isDefault = format.audio_track ? format.audio_track.audio_is_default : !format.audioTrackId;
  const dubbed = (format.is_dubbed ?? format.isDubbed) || (format.is_auto_dubbed ?? format.isAutoDubbed);
  if (original) return 0;
  if (isDefault && !dubbed) return 1;
  if (!dubbed) return 2;
  return isDefault ? 3 : 4;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
/**
 * Visitor data minted by a real page view. Anonymous InnerTube player requests
 * without it answer "Sign in to confirm you're not a bot"; with it the visionOS
 * client returns plain, fully rangeable videoplayback URLs (the client yt-dlp uses).
 */
export function fetchVisitorData() {
  return new Promise((resolve, reject) => {
    const request = https.get('https://www.youtube.com/', { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' }, maxHeaderSize: 256 * 1024, timeout: 15000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 4 * 1024 * 1024) body += chunk; });
      response.on('end', () => {
        const visitor = /"VISITOR_DATA":"([A-Za-z0-9_%=-]+)"/.exec(body)?.[1];
        if (visitor) resolve(visitor); else reject(new Error('YouTube did not provide visitor data.'));
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('YouTube page request timed out.')));
    request.on('error', reject);
  });
}
/** True when the host serves a 1 KiB slice from the middle of the file (anonymous clients without a PoToken stop after ~1 MiB). */
export async function defaultProbe(url, contentLength) {
  const size = Number(contentLength) || 0;
  const from = size > 4 * 1024 * 1024 ? Math.floor(size / 2) : 3 * 1024 * 1024;
  if (size && from >= size) return true;
  try {
    const response = await fetch(url, { headers: { Range: `bytes=${from}-${from + 1023}` }, signal: AbortSignal.timeout(8000) });
    await response.body?.cancel().catch(() => {});
    return response.status === 206;
  } catch { return false; }
}
export function createInnertubeService({
  getConnection, saveConfig, env = process.env, fetchImpl = globalThis.fetch, now = Date.now, log = console,
  // 720p30 is what the Tesla browser decodes comfortably; raise with YOUTUBE_MAX_HEIGHT=1080.
  createInnertube, cacheFactory, maxHeight = [1080, 720, 480, 360].includes(Number(env.YOUTUBE_MAX_HEIGHT)) ? Number(env.YOUTUBE_MAX_HEIGHT) : 720,
  pageLifetime = 15 * 60000, requestTimeout = 25000,
  probe = defaultProbe, visitorData = fetchVisitorData, visitorLifetime = 6 * 3600000,
  potProviderUrl = env.YOUTUBE_POT_PROVIDER_URL || '', potLifetime = 5 * 3600000,
  sabr = null, sabrMode = env.YOUTUBE_SABR || 'auto', liveSession = createLiveSession,
  resolvedLifetime = 30 * 60000,
} = {}) {
  const pending = new Map(); // connectionId -> device authorization in progress
  const clients = new Map(); // `${connectionId}:${role}` -> { key, promise }; roles: browse (current TV client), player (TV_PLAYER_CLIENT)
  const pages = new Map(); // continuation token -> { feed, userId, connectionId, expires, map }
  const resolved = new Map(); // `${connectionId}:${videoId}` -> { result, expires }: stream URLs stay valid for hours
  let anonymous = null, anonymousExpires = 0, library = null;
  // A client the user created in Google Cloud wins; otherwise YouTube's own TV-app client, read
  // from youtube.com/tv by youtubei.js and remembered on the connection after a successful sign-in.
  const customClient = c => {
    const clientId = c.config.tvClientId || env.GOOGLE_TV_CLIENT_ID || '', clientSecret = c.config.tvClientSecret || env.GOOGLE_TV_CLIENT_SECRET || '';
    return clientId && clientSecret ? { clientId, clientSecret, kind: 'custom' } : null;
  };
  let builtin = null, builtinExpires = 0;
  async function builtinClient() {
    if (!builtin || builtinExpires < now()) {
      builtinExpires = now() + 12 * 3600000;
      builtin = (async () => {
        const yt = await build({ retrieve_player: false });
        const identity = await timed(yt.session.oauth.getClientID());
        if (!identity?.client_id || !identity?.client_secret) throw providerError('YouTube did not provide its TV sign-in client. Try again later or save your own TV OAuth client.', 502);
        return { clientId: identity.client_id, clientSecret: identity.client_secret, kind: 'youtube' };
      })();
      builtin.catch(() => { builtin = null; });
    }
    return builtin;
  }
  const savedBuiltin = c => c.config.tvBuiltinClientId && c.config.tvBuiltinClientSecret ? { clientId: c.config.tvBuiltinClientId, clientSecret: c.config.tvBuiltinClientSecret, kind: 'youtube' } : null;
  const tvClient = async (c, fresh = false) => customClient(c) || (!fresh && savedBuiltin(c)) || builtinClient();
  const configured = c => Boolean(customClient(c));
  const endpoints = kind => kind === 'youtube'
    ? { code: YT_DEVICE_CODE_URL, token: YT_TOKEN_URL, revoke: YT_REVOKE_URL, deviceGrant: 'http://oauth.net/grant_type/device/1.0', codeKey: 'code', json: true }
    : { code: DEVICE_CODE_URL, token: TOKEN_URL, revoke: REVOKE_URL, deviceGrant: 'urn:ietf:params:oauth:grant-type:device_code', codeKey: 'device_code', json: false };
  const post = async (url, body, json) => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(), signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    if (data.error_code && !data.error) data.error = data.error_code;
    return { ok: response.ok && !data.error, data };
  };
  async function youtubei() {
    library ??= import('youtubei.js').then(module => {
      // youtubei.js leaves running YouTube's obfuscated player script (signature and n-parameter
      // transforms) to the host. Run it in a bare V8 context with no access to Node APIs.
      module.Platform.shim.eval = (data, env) => vm.runInNewContext(`(function () {\n${data.output}\n})()`, { ...env }, { timeout: 5000 });
      return module;
    });
    return library;
  }
  async function build(options = {}) {
    if (createInnertube) return createInnertube(options);
    const { Innertube, UniversalCache, Log } = await youtubei();
    Log.setLevel(Log.Level.ERROR);
    const cache = cacheFactory ? cacheFactory() : new UniversalCache(false);
    return Innertube.create({ cache, generate_session_locally: true, retrieve_player: true, ...options });
  }
  const timed = (promise, message = 'YouTube did not respond in time.') => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(providerError(message, 504)), requestTimeout).unref?.())]);
  const googleToken = (client, body) => post(endpoints(client.kind).token, { client_id: client.clientId, client_secret: client.clientSecret, ...body }, endpoints(client.kind).json);
  async function startSignIn(req, c) {
    if (c.shared) throw providerError('Only the connection owner can sign in to this shared connection.', 403);
    for (const [key, value] of pending) if (value.expires < now()) pending.delete(key);
    if (pending.size > 200) throw providerError('Too many pending Google sign-ins. Try again shortly.', 429);
    const client = await tvClient(c, true);
    const api = endpoints(client.kind);
    let result;
    for (const scope of client.kind === 'youtube' ? [TV_SCOPES[0]] : TV_SCOPES) {
      const { ok, data } = await post(api.code, { client_id: client.clientId, scope, ...(api.json ? { device_id: randomBytes(16).toString('hex'), device_model: 'ytlr::' } : {}) }, api.json);
      if (ok && data.device_code && data.user_code) { result = { ...data, scope }; break; }
      if (data.error === 'invalid_scope') continue;
      if (data.error === 'invalid_client') throw providerError(client.kind === 'youtube' ? 'YouTube rejected its TV sign-in client. Try again later, or save your own Google TV OAuth client in YouTube settings.' : 'Google rejected the TV OAuth client ID. Check it in YouTube settings; the client type must be "TVs and Limited Input devices".', 409);
      throw providerError('Google could not start device sign-in. Try again in a moment.', 502);
    }
    if (!result) throw providerError('Google rejected every YouTube scope for this OAuth client. Enable the YouTube Data API v3 in the Google Cloud project and try again.', 409);
    const entry = {
      deviceCode: result.device_code, userCode: result.user_code, verificationUrl: result.verification_url || 'https://www.google.com/device',
      interval: Math.min(Math.max(Number(result.interval) || 5, 3), 30) * 1000, expires: now() + (Number(result.expires_in) || 1800) * 1000,
      userId: req.user.id, client, scope: result.scope, nextPoll: 0, status: 'pending',
    };
    pending.set(c.id, entry);
    return publicStatus(entry);
  }
  const publicStatus = entry => ({ status: entry.status, userCode: entry.userCode, verificationUrl: entry.verificationUrl, expiresAt: new Date(entry.expires).toISOString(), interval: Math.round(entry.interval / 1000) });
  async function signInStatus(req, c) {
    const entry = pending.get(c.id);
    if (!entry || entry.userId !== req.user.id) return { status: innertubeSignedIn(c) ? 'authorized' : 'none' };
    if (entry.expires < now()) { pending.delete(c.id); return { status: 'expired' }; }
    if (entry.nextPoll > now()) return publicStatus(entry);
    entry.nextPoll = now() + entry.interval;
    const client = entry.client;
    if (customClient(c)?.clientId !== (client.kind === 'custom' ? client.clientId : undefined)) { pending.delete(c.id); throw providerError('Google client settings changed. Start sign-in again.'); }
    const api = endpoints(client.kind);
    const { ok, data } = await googleToken(client, { [api.codeKey]: entry.deviceCode, grant_type: api.deviceGrant });
    if (!ok || !data.access_token) {
      if (data.error === 'authorization_pending') return publicStatus(entry);
      if (data.error === 'slow_down') { entry.interval = Math.min(entry.interval + 5000, 60000); return publicStatus(entry); }
      pending.delete(c.id);
      if (data.error === 'access_denied') return { status: 'denied' };
      if (data.error === 'expired_token') return { status: 'expired' };
      if (data.error === 'invalid_client') throw providerError(client.kind === 'youtube' ? 'YouTube rejected its TV sign-in client. Start again later, or save your own Google TV OAuth client.' : 'Google rejected the TV OAuth client secret. Check it in YouTube settings and start again.', 409);
      throw providerError('Google did not complete the sign-in. Start again.', 502);
    }
    pending.delete(c.id);
    if (!data.refresh_token) throw providerError('Google did not return a refresh token. Remove TesPlay from your Google account permissions and sign in again.', 502);
    forgetClients(c.id);
    saveConfig(req, c, {
      authMode: 'innertube', tvAccessToken: data.access_token,
      // Settings of the retired Data API connection go once the phone sign-in replaces them.
      apiKey: null, clientId: null, clientSecret: null, accessToken: null, refreshToken: null, expiresAt: null, tvRefreshToken: data.refresh_token, tvExpiresAt: now() + Number(data.expires_in || 3600) * 1000, tvScope: entry.scope,
      // Tokens belong to the client that issued them; keep YouTube's client beside them for refreshes.
      tvBuiltinClientId: client.kind === 'youtube' ? client.clientId : null, tvBuiltinClientSecret: client.kind === 'youtube' ? client.clientSecret : null,
    });
    return { status: 'authorized' };
  }
  function cancelSignIn(req, c) { const entry = pending.get(c.id); if (entry && entry.userId === req.user.id) pending.delete(c.id); }
  async function signOut(req, c) {
    if (c.shared) throw providerError('Only the connection owner can sign out of this shared connection.', 403);
    cancelSignIn(req, c); forgetClients(c.id);
    const token = c.config.tvRefreshToken || c.config.tvAccessToken;
    if (token) { try { await fetchImpl(`${endpoints(savedBuiltin(c) && !customClient(c) ? 'youtube' : 'custom').revoke}?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10000) }); } catch { /* Local sign-out still proceeds. */ } }
    saveConfig(req, c, { tvAccessToken: null, tvRefreshToken: null, tvExpiresAt: 0, tvBuiltinClientId: null, tvBuiltinClientSecret: null });
  }
  const refreshes = new Map();
  async function accessToken(req, c) {
    const current = getConnection(req, c.id);
    if (!innertubeSignedIn(current)) throw providerError(SIGN_IN_REQUIRED, 409);
    const client = await tvClient(current);
    if (current.config.tvAccessToken && Number(current.config.tvExpiresAt) > now() + 60000) return { accessToken: current.config.tvAccessToken, refreshToken: current.config.tvRefreshToken, expiresAt: Number(current.config.tvExpiresAt), client };
    const key = `${c.id}:${createHash('sha256').update(current.config.tvRefreshToken).digest('hex')}`;
    let flight = refreshes.get(key);
    if (!flight) {
      flight = (async () => {
        const { ok, data } = await googleToken(client, { refresh_token: current.config.tvRefreshToken, grant_type: 'refresh_token' });
        if (!ok || !data.access_token) {
          if (data.error === 'invalid_grant') throw providerError(RECONNECT_REQUIRED, 409);
          if (data.error === 'invalid_client') throw providerError('Google rejected the TV OAuth client settings. Check the client ID and secret in YouTube settings, then sign in again.', 409);
          throw providerError('Google could not refresh YouTube access. Try again in a moment.', 502);
        }
        const refreshed = { tvAccessToken: data.access_token, tvExpiresAt: now() + Number(data.expires_in || 3600) * 1000 };
        saveConfig(req, c, refreshed);
        return { accessToken: refreshed.tvAccessToken, refreshToken: current.config.tvRefreshToken, expiresAt: refreshed.tvExpiresAt, client };
      })();
      refreshes.set(key, flight);
    }
    try { return await flight; } finally { if (refreshes.get(key) === flight) refreshes.delete(key); }
  }
  const tokenSet = t => ({ access_token: t.accessToken, refresh_token: t.refreshToken, expiry_date: new Date(t.expiresAt).toISOString(), client: { client_id: t.client.clientId, client_secret: t.client.clientSecret } });
  const forgetClients = id => { for (const key of clients.keys()) if (key.startsWith(`${id}:`)) clients.delete(key); };
  /**
   * A signed-in TV client for the connection. The `browse` role is the current TV client (feeds
   * come back as tiles); the `player` role declares the older TV version whose player responses
   * still carry plain stream URLs, so a video plays by byte range without SABR.
   */
  async function signedClient(req, c, role = 'browse') {
    const token = await accessToken(req, c);
    const key = createHash('sha256').update(`${token.refreshToken}:${token.client.clientId}`).digest('hex');
    const slot = `${c.id}:${role}`;
    let entry = clients.get(slot);
    if (!entry || entry.key !== key) {
      const promise = (async () => {
        // YouTube only honours the TV app's tokens on InnerTube requests made as the TV client.
        const yt = await build({ client_type: 'TVHTML5' });
        if (role === 'player') Object.assign(yt.session.context.client, TV_PLAYER_CLIENT);
        yt.session.on?.('update-credentials', ({ credentials }) => {
          if (credentials?.access_token) { try { saveConfig(req, c, { tvAccessToken: credentials.access_token, tvExpiresAt: Date.parse(credentials.expiry_date) || now() + 3600000 }); } catch (error) { log.warn?.('YouTube token save failed', error.message); } }
        });
        yt.session.on?.('auth-error', error => log.warn?.('YouTube auth error', error?.message));
        await yt.session.signIn(tokenSet(token));
        return yt;
      })();
      entry = { key, promise };
      clients.set(slot, entry);
      promise.catch(() => { if (clients.get(slot) === entry) clients.delete(slot); });
    }
    const yt = await entry.promise;
    if (yt.session.oauth?.oauth2_tokens && yt.session.oauth.oauth2_tokens.access_token !== token.accessToken) yt.session.oauth.setTokens(tokenSet(token));
    return yt;
  }
  /**
   * Proof-of-origin token from a bgutil-ytdlp-pot-provider HTTP server, bound to the
   * visitor data. YouTube asks for one from datacenter addresses ("Sign in to confirm
   * you're not a bot") and refuses to serve more than a slice of a file without it.
   */
  const pots = new Map();
  async function poToken(binding) {
    if (!potProviderUrl || !binding) return undefined;
    const cached = pots.get(binding);
    if (cached && cached.expires > now()) return cached.token;
    const url = new URL('/get_pot', potProviderUrl.endsWith('/') ? potProviderUrl : `${potProviderUrl}/`);
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content_binding: binding }), signal: AbortSignal.timeout(60000) });
    const data = await response.json().catch(() => ({}));
    const token = data.poToken || data.po_token;
    if (!response.ok || typeof token !== 'string' || !token) throw providerError(`The proof-of-origin token provider answered ${response.status}${data.error ? `: ${String(data.error).slice(0, 120)}` : ''}.`, 502);
    const expires = Math.min(Date.parse(data.expiresAt) || Infinity, now() + potLifetime);
    pots.set(binding, { token, expires });
    if (pots.size > 50) pots.delete(pots.keys().next().value);
    return token;
  }
  async function anonymousClient(renew = false) {
    if (!anonymous || renew || anonymousExpires < now()) {
      anonymousExpires = now() + visitorLifetime;
      anonymous = (async () => {
        const visitor = await visitorData();
        const pot = await poToken(visitor).catch(error => { log.warn?.('YouTube proof-of-origin token unavailable:', error.message); return undefined; });
        return build({ visitor_data: visitor, ...(pot ? { po_token: pot } : {}) });
      })();
      anonymous.catch(() => { anonymous = null; });
    }
    return anonymous;
  }
  const potConfigured = () => Boolean(potProviderUrl);
  function translate(error) {
    if (error?.status) return error;
    const message = String(error?.message || '');
    if (/sign in|login_required|unauthorized|401/i.test(message)) return providerError(RECONNECT_REQUIRED, 409);
    if (/not found|404|unavailable/i.test(message)) return providerError('YouTube could not find that content.', 404);
    log.warn?.('YouTube InnerTube request failed:', message.slice(0, 300));
    return providerError('YouTube did not return this content. Try again in a moment.', 502);
  }
  const guard = async (work) => { try { return await timed(work()); } catch (error) { throw translate(error); } };
  /** Remember how to fetch the next page; the caller gets an opaque token. */
  function pageToken(req, c, next) {
    for (const [key, value] of pages) if (value.expires < now()) pages.delete(key);
    if (pages.size >= 500) pages.delete(pages.keys().next().value);
    if (!next) return null;
    const token = randomBytes(12).toString('base64url');
    pages.set(token, { next, userId: req.user.id, connectionId: c.id, expires: now() + pageLifetime });
    return token;
  }
  async function continuation(req, c, token) {
    const entry = pages.get(token);
    if (!entry || entry.userId !== req.user.id || entry.connectionId !== c.id || entry.expires < now()) throw providerError('This page expired. Reload the list.', 410);
    pages.delete(token);
    return entry.next();
  }
  const context = c => ({ connectionId: c.id });
  const mappers = {
    items: (c, nodes) => ({ items: uniqueBy(nodes.map(n => videoItem(n, context(c), now())), 'id') }),
    channels: (_c, nodes) => ({ channels: uniqueBy(nodes.map(channelItem), 'id') }),
    playlists: (_c, nodes) => ({ playlists: uniqueBy(nodes.map(playlistItem), 'id') }),
  };
  /**
   * A signed-in TV-app browse surface (Home, subscriptions, history, playlists, a playlist, a channel).
   * The TV responses carry tileRenderer nodes that youtubei.js does not collect, so read them raw.
   */
  async function tvPage(req, c, args, kind) {
    const yt = await signedClient(req, c);
    const response = await guard(() => yt.actions.execute('/browse', args));
    const page = rawTvPage(await response.data);
    const result = mappers[kind](c, page.tiles);
    return { ...result, nextPageToken: pageToken(req, c, page.continuation ? () => tvPage(req, c, { continuation: page.continuation }, kind) : null) };
  }
  const browse = (browseId, kind) => (req, c, token) => token ? continuation(req, c, token) : tvPage(req, c, { browseId }, kind);
  const home = browse('FEwhat_to_watch', 'items');
  const subscriptionsFeed = browse('FEsubscriptions', 'items');
  const history = browse('FEhistory', 'items');
  const channels = browse('FEchannels', 'channels');
  const playlists = browse('FEplaylist_aggregation', 'playlists');
  async function search(req, c, query, token) {
    const yt = await signedClient(req, c);
    const q = String(query || '').trim().slice(0, 200);
    if (!q) return { items: [], channels: [], nextPageToken: null };
    if (token) return continuation(req, c, token);
    const page = async feed => ({ ...mappers.items(c, feedNodes(feed)), nextPageToken: pageToken(req, c, feed.has_continuation ? async () => page(await guard(() => feed.getContinuation())) : null) });
    const [videos, mixed] = await Promise.all([guard(() => yt.search(q, { type: 'video' })), guard(() => yt.search(q)).catch(() => null)]);
    return { ...await page(videos), channels: uniqueBy([...(mixed?.channels || []), ...feedNodes(mixed, 'channels')].map(channelItem), 'id').slice(0, 12) };
  }
  async function channelVideos(req, c, channelId, token) {
    if (!CHANNEL_ID.test(String(channelId))) throw providerError('Invalid YouTube channel.');
    if (token) return continuation(req, c, token);
    // Public channel pages list uploads newest first through the web client; the TV surface mixes shelves.
    try {
      const yt = await anonymousClient();
      const channel = await guard(() => yt.getChannel(channelId));
      if (!channel.has_videos) throw providerError('This channel has no available uploads.', 404);
      const title = text(channel.metadata?.title);
      const map = feed => ({ items: uniqueBy(feedNodes(feed).map(n => videoItem(n, { connectionId: c.id, channel: { id: channelId, title } }, now())), 'id') });
      const paged = async feed => ({ ...map(feed), nextPageToken: pageToken(req, c, feed.has_continuation ? async () => paged(await guard(() => feed.getContinuation())) : null) });
      return paged(await guard(() => channel.getVideos()));
    } catch (error) {
      if (error?.status === 404) throw error;
      return tvPage(req, c, { browseId: channelId, params: 'EgZ2aWRlb3PyBgQKAjoA' }, 'items');
    }
  }
  async function playlistVideos(req, c, playlistId, token) {
    if (!PLAYLIST_ID.test(String(playlistId))) throw providerError('Invalid YouTube playlist.');
    if (token) return continuation(req, c, token);
    return tvPage(req, c, { browseId: `VL${playlistId}` }, 'items');
  }
  async function test(req, c) {
    if (!innertubeSignedIn(c)) throw providerError(SIGN_IN_REQUIRED, 409);
    await tvPage(req, c, { browseId: 'FEwhat_to_watch' }, 'items');
    return true;
  }
  /**
   * The signed-in TV client only offers server-side adaptive streaming (SABR). Spool the chosen
   * H.264 and AAC tracks to disk through the googlevideo client and hand the player two growing
   * fragmented-MP4 files. One session per video is shared by every reader.
   */
  async function startSabr(req, c, videoId, yt, info, height) {
    const session = await sabr.open(`${c.id}:${videoId}:${height ? `h${height}` : maxHeight}`, async (session) => {
      const [{ SabrStream }, { buildSabrFormat, EnabledTrackTypes }, { Constants }] = await Promise.all([import('googlevideo/sabr-stream'), import('googlevideo/utils'), youtubei()]);
      const streamingData = info.streaming_data;
      const config = info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
      if (!streamingData?.server_abr_streaming_url || !config) throw providerError('YouTube did not provide an adaptive streaming session for this video.', 502);
      const serverAbrStreamingUrl = await yt.session.player.decipher(streamingData.server_abr_streaming_url);
      const clientName = parseInt(Constants.CLIENT_NAME_IDS[yt.session.context.client.clientName]) || 7;
      const clientVersion = yt.session.context.client.clientVersion;
      const reload = async () => {
        const fresh = await timed(yt.getBasicInfo(videoId, { client: 'TV' }));
        return { serverAbrStreamingUrl: await yt.session.player.decipher(fresh.streaming_data.server_abr_streaming_url), videoPlaybackUstreamerConfig: fresh.player_config.media_common_config.media_ustreamer_request_config.video_playback_ustreamer_config };
      };
      const pot = await poToken(yt.session.context.client.visitorData).catch(() => undefined);
      const h264 = formats => formats.filter(f => /avc1/i.test(f.mimeType || ''));
      const aac = formats => formats.filter(f => f.hasAudio && /mp4a/i.test(f.mimeType || '') && (f.numChannels || 2) <= 2 && !f.isDescriptive && !f.isAutoDubbed)
        .sort((a, b) => audioRank(a) - audioRank(b) || processed(a) - processed(b) || (b.bitrate || 0) - (a.bitrate || 0))[0];
      const formats = streamingData.adaptive_formats.map(buildSabrFormat);
      const video = pickVideo(h264(formats), { maxHeight, height }), audio = aac(formats);

      if (!video || !audio) throw providerError('YouTube offered no H.264 and AAC tracks for adaptive streaming.', 422);
      log.info?.(`YouTube SABR ${videoId}: video itag ${video.itag} ${video.height || ''}p, audio itag ${audio.itag} ${Math.round((audio.averageBitrate || audio.bitrate || 0) / 1000)}k${audio.language ? ` ${audio.language}` : ''}${audio.isOriginal ? ' original' : ''}${audio.isDrc ? ' drc' : ''}${audio.isVb ? ' voice-boost' : ''}.`);
      // One SABR stream at a time; a reader that needs data elsewhere restarts it at that time.
      const launch = async (startTimeMs) => {
        const stream = new SabrStream({
          videoId, serverAbrStreamingUrl, videoPlaybackUstreamerConfig: config, formats, stripDuplicateInit: true,
          clientInfo: { clientName, clientVersion }, ...(pot ? { poToken: pot } : {}), callbacks: { onReloadPlayerResponse: reload },
        });
        const handle = { ended: false, abort: async () => { handle.ended = true; await stream.abort().catch(() => {}); } };
        stream.on('streamProtectionStatusUpdate', status => { if (status?.status && status.status !== 1) log.warn?.(`YouTube SABR ${videoId}: stream protection status ${status.status} (a proof-of-origin token may be required).`); });
        stream.on('error', error => { handle.ended = true; log.warn?.(`YouTube SABR ${videoId}: ${error.message}`); if (!session.video.layout) { void session.video.fail(error); void session.audio.fail(error); } });
        stream.on('finish', () => { handle.ended = true; });
        const { videoStream, audioStream } = stream.start({ videoFormat: video, audioFormat: audio, enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO, isPostLiveDvr: false, startTimeMs });
        const pipe = (readable, target) => readable.pipeTo(new WritableStream({ write: chunk => target.ingest(chunk) })).catch(() => {}).finally(() => { handle.ended = true; });
        void pipe(videoStream, session.video); void pipe(audioStream, session.audio);
        return handle;
      };
      return { selected: { video, audio }, qualities: videoQualities(h264(formats)), launch };
    });
    // A failed start reaches the player through the spooled files, as before.
    const selection = await session.selection?.catch(() => null);
    return { sabr: session, video: { spool: session.video }, audio: { spool: session.audio }, isLive: false, via: 'innertube-sabr', title: text(info.basic_info?.title),
      ...(selection?.selected?.video ? { picture: describe(selection.selected.video) } : {}), qualities: selection?.qualities || [] };
  }
  /** A live session over the H.264 and AAC segment URLs of a live player response, or null without them. */
  async function liveStreams(yt, info, videoId, height) {
    const chosen = chooseStreams(info.streaming_data, { maxHeight, height });
    if (!chosen) return null;
    const urls = async (streamingData, video, audio) => {
      const pick = itag => streamingData?.adaptive_formats?.find(f => f.itag === itag && (f.url || f.signature_cipher || f.cipher));
      const formats = [pick(video), pick(audio)];
      if (formats.some(f => !f)) return null;
      const [v, a] = await Promise.all(formats.map(async format => {
        const url = validateRemoteUrl(await format.decipher(yt.session.player));
        if (url.protocol !== 'https:' || !/(?:^|\.)googlevideo\.com$/.test(url.hostname)) throw new Error('unexpected stream host');
        return { url: url.href, itag: format.itag };
      }));
      return { video: v, audio: a };
    };
    const first = await urls(info.streaming_data, chosen.video.itag, chosen.audio.itag);
    if (!first) return null;
    // Stream URLs expire after a few hours; a long broadcast asks the same client for fresh ones.
    const refresh = async () => urls((await timed(yt.getBasicInfo(videoId, {}))).streaming_data, chosen.video.itag, chosen.audio.itag);
    log.info?.(`YouTube live ${videoId}: video itag ${chosen.video.itag} ${chosen.video.height || ''}p, audio itag ${chosen.audio.itag}.`);
    const session = await liveSession({ video: first.video, audio: first.audio, targetDurationSec: chosen.video.target_duration_sec || 5, refresh, log });
    return { session, picture: describe(chosen.video), qualities: chosen.qualities };
  }
  /** Direct H.264 + AAC stream URLs for TesPlayer's dual-input path, or null when InnerTube cannot supply them. */
  const resolvedKey = (c, videoId, height) => `${c?.id || ''}:${videoId}:${height || 'auto'}`;
  /** Reopening or resuming a video reuses its stream URLs instead of asking YouTube again. */
  function remember(c, videoId, height, result) {
    const expire = Number(new URL(result.video.url).searchParams.get('expire')) * 1000;
    // Stop handing a URL out well before googlevideo stops honouring it.
    const expires = Math.min(now() + resolvedLifetime, Number.isFinite(expire) && expire > 0 ? expire - 20 * 60000 : Infinity);
    if (expires <= now()) return;
    for (const [key, entry] of resolved) if (entry.expires <= now()) resolved.delete(key);
    if (resolved.size >= 200) resolved.delete(resolved.keys().next().value);
    resolved.set(resolvedKey(c, videoId, height), { result, expires });
  }
  /** Drop remembered URLs that googlevideo has started refusing. */
  function forget(c, videoId) { const prefix = resolvedKey(c, videoId, '').slice(0, -'auto'.length); for (const key of [...resolved.keys()]) if (key.startsWith(prefix)) resolved.delete(key); }
  /** Prepare the player-role client ahead of the first play (it fetches YouTube's player script). */
  function warm(req, c) {
    if (c && innertubeSignedIn(c)) signedClient(req, c, 'player').catch(() => {});
  }
  /** Stream addresses for a video; `height` asks for one picture size (see pickVideo), otherwise automatic. */
  async function resolve(req, c, videoId, signal, { height } = {}) {
    if (!VIDEO_ID.test(String(videoId))) throw providerError('Enter a valid YouTube video ID.', 400);
    height = youtubeHeight(height);
    const known = resolved.get(resolvedKey(c, videoId, height));
    if (known && known.expires > now()) return known.result;
    const result = await resolveFresh(req, c, videoId, signal, height);
    if (result?.video?.url && !result.isLive && result.via !== 'innertube-tv-sabr') remember(c, videoId, height, result);
    return result;
  }
  async function resolveFresh(req, c, videoId, signal, height) {
    let sabrCandidate = null;
    const attempts = [];
    if (c && innertubeSignedIn(c)) {
      // The player-role session already declares the older TV client, so the request goes out
      // as the session is; naming `client: 'TV'` would put the current version back.
      attempts.push({ client: 'TV', via: 'innertube-tv', open: () => signedClient(req, c, 'player'), options: {} });
      if (sabr && sabrMode !== 'off') attempts.push({ client: 'TV', via: 'innertube-tv-sabr', open: () => signedClient(req, c), options: { client: 'TV' } });
    }
    // visionOS is the one anonymous client that still hands out plain URLs; with a proof-of-origin
    // token (when a provider is configured) its player request and stream URLs carry the token.
    attempts.push({ client: 'VISIONOS', via: 'innertube-visionos', open: () => anonymousClient(), renew: () => anonymousClient(true), options: { client: 'VISIONOS' } });
    let lastReason = '';
    for (const attempt of attempts) {
      if (signal?.aborted) throw signal.reason;
      try {
        let yt = await attempt.open();
        let info = await timed(yt.getBasicInfo(videoId, attempt.options));
        let status = info.playability_status?.status;
        if (status === 'LOGIN_REQUIRED' && attempt.renew) {
          // Stale visitor data trips the bot check; mint fresh visitor data once and retry.
          yt = await attempt.renew();
          info = await timed(yt.getBasicInfo(videoId, attempt.options));
          status = info.playability_status?.status;
        }
        if (info.basic_info?.is_live && attempt.via === 'innertube-tv' && status === 'OK') {
          // The older TV client lists a live broadcast as per-segment URLs; relay them as growing fragmented MP4.
          const live = await liveStreams(yt, info, videoId, height);
          if (live) return { isLive: true, live: live.session, picture: live.picture, qualities: live.qualities, via: 'innertube-tv-live', title: text(info.basic_info?.title) };
          lastReason = 'TV: live broadcast without H.264/AAC segment URLs'; continue;
        }
        if (info.basic_info?.is_live || info.basic_info?.is_upcoming) return { isLive: true, info: info.basic_info };
        if (status && status !== 'OK') { lastReason = `${attempt.client}: ${status} ${info.playability_status?.reason || ''}`.trim(); continue; }
        const chosen = chooseStreams(info.streaming_data, { maxHeight, height });
        if (!chosen) {
          if (attempt.via === 'innertube-tv-sabr' && info.streaming_data?.server_abr_streaming_url) {
            sabrCandidate = { yt, info };
            if (sabrMode === 'prefer') break;
          }
          lastReason = `${attempt.client}: no progressive H.264/AAC formats (SABR only)`; continue;
        }
        const endpoint = async format => {
          const url = validateRemoteUrl(await format.decipher(yt.session.player));
          if (url.protocol !== 'https:' || !/(?:^|\.)googlevideo\.com$/.test(url.hostname)) throw new Error('unexpected stream host');
          return { url: url.href, headers: {}, hls: false, itag: format.itag, height: format.height, mimeType: format.mime_type };
        };
        const [video, audio] = await Promise.all([endpoint(chosen.video), endpoint(chosen.audio)]);
        // Without a proof-of-origin token anonymous clients get URLs that only serve the first
        // megabyte, so read a slice from the middle of each file before handing them out. The
        // signed-in TV client's URLs serve any range; checking them only delays the first frame.
        const usable = attempt.client === 'TV' || (await Promise.all([video, audio].map(stream => probe(stream.url, chosen.video === stream ? chosen.video.content_length : chosen.audio.content_length)))).every(Boolean);
        if (!usable) { lastReason = `${attempt.client}: videoplayback refused a mid-file range (proof-of-origin token required)`; continue; }
        return { video, audio, isLive: false, via: attempt.via, title: text(info.basic_info?.title), picture: describe(chosen.video), qualities: chosen.qualities };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error?.status === 409 && attempt.client === 'TV') { lastReason = 'TV: not signed in'; continue; }
        if (attempt.client !== 'TV') anonymous = null;
        lastReason = `${attempt.client}: ${String(error?.message || error).slice(0, 200)}`;
      }
    }
    if (sabrCandidate) {
      try { return await startSabr(req, c, videoId, sabrCandidate.yt, sabrCandidate.info, height); }
      catch (error) { if (signal?.aborted) throw signal.reason; lastReason = `SABR: ${String(error?.message || error).slice(0, 200)}`; }
    }
    log.warn?.(`YouTube InnerTube could not resolve ${videoId} (${lastReason}); falling back to yt-dlp.`);
    return null;
  }
  return { mode: isInnertubeMode, signedIn: innertubeSignedIn, configured, potConfigured, startSignIn, signInStatus, cancelSignIn, signOut, home, subscriptionsFeed, history, channels, playlists, search, channelVideos, playlistVideos, test, resolve, forget, warm,
    _internal: { pending, pages, clients, resolved } };
}

/** Express routes under /api/youtube/:connectionId for YouTube connections. */
export function registerInnertubeRoutes(app, { connection, route, art, service, limiter = (req, res, next) => next() }) {
  const root = '/api/youtube/:connectionId';
  const token = req => { const value = String(req.query.pageToken || ''); if (value.length > 64 || !/^[A-Za-z0-9_-]*$/.test(value)) throw providerError('Invalid YouTube page.'); return value || undefined; };
  const withArt = (req, c, result) => ({
    ...result,
    ...(result.items ? { items: result.items.map(item => ({ ...item, poster: art(req, c, item.poster) })) } : {}),
    ...(result.channels ? { channels: result.channels.map(ch => ({ ...ch, thumbnail: art(req, c, ch.thumbnail) })) } : {}),
    ...(result.playlists ? { playlists: result.playlists.map(pl => ({ ...pl, thumbnail: art(req, c, pl.thumbnail) })) } : {}),
  });
  // The shared route() helper does not pass next; InnerTube handlers need it to fall through.
  const only = handler => (req, res, next) => Promise.resolve().then(() => {
    const c = connection(req, req.params.connectionId, 'youtube');
    if (!service.mode(c)) return next('route');
    return handler(req, res, c);
  }).catch(next);
  const owner = (req, c) => { if (c.shared) throw providerError('Only the connection owner can change Google sign-in for this connection.', 403); };
  app.post(root + '/signin/start', limiter, only(async (req, res, c) => { owner(req, c); res.json(await service.startSignIn(req, c)); }));
  app.get(root + '/signin/status', only(async (req, res, c) => { owner(req, c); res.json(await service.signInStatus(req, c)); }));
  app.post(root + '/signin/cancel', only(async (req, res, c) => { owner(req, c); service.cancelSignIn(req, c); res.json({ status: 'none' }); }));
  app.post(root + '/signout', only(async (req, res, c) => { owner(req, c); await service.signOut(req, c); res.json({ ok: true }); }));
  app.get(root + '/home', only(async (req, res, c) => { service.warm?.(req, c); res.json(withArt(req, c, await service.home(req, c, token(req)))); }));
  app.get(root + '/history', only(async (req, res, c) => res.json(withArt(req, c, await service.history(req, c, token(req))))));
  app.get(root + '/feed', only(async (req, res, c) => res.json({ ...withArt(req, c, await service.subscriptionsFeed(req, c, token(req))), channelRows: [], basis: 'subscriptions' })));
  app.get(root + '/subscriptions', only(async (req, res, c) => res.json(withArt(req, c, await service.channels(req, c, token(req))))));
  app.get(root + '/playlists', only(async (req, res, c) => res.json(withArt(req, c, await service.playlists(req, c, token(req))))));
  app.get(root + '/search', only(async (req, res, c) => res.json(withArt(req, c, await service.search(req, c, req.query.q, token(req))))));
  app.get(root + '/channel/:channelId/videos', only(async (req, res, c) => res.json(withArt(req, c, await service.channelVideos(req, c, req.params.channelId, token(req))))));
  app.get(root + '/playlist/:playlistId/videos', only(async (req, res, c) => res.json(withArt(req, c, await service.playlistVideos(req, c, req.params.playlistId, token(req))))));
}
