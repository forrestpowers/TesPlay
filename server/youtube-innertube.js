// YouTube through InnerTube (the API YouTube's own apps use) with the youtubei.js
// client, signed in with Google's device-code flow for "TVs and Limited Input
// devices". The user types a short code at google.com/device on any phone, so no
// typing or redirect happens on the car screen. Browsing (Home, subscriptions,
// history, search, channels, playlists) carries the account; stream resolution
// prefers the signed-in TV client, then the anonymous iOS client, and the caller
// falls back to yt-dlp when neither yields plain videoplayback URLs.
import { createHash, randomBytes } from 'node:crypto';
import https from 'node:https';
import { providerError, validateRemoteUrl } from './media.js';
import { plainText } from './text.js';

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
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/, CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/, PLAYLIST_ID = /^(?:WL|LL|[A-Za-z0-9_-]{10,100})$/; // WL = Watch later, LL = Liked videos
const SHORT_TYPES = new Set(['ReelItem', 'ShortsLockupView']);
const text = value => plainText(value == null ? '' : typeof value === 'string' ? value : typeof value.text === 'string' ? value.text : typeof value.toString === 'function' ? value.toString() : '').trim();

export function isInnertubeMode(c) { return c?.config?.authMode === 'innertube'; }
export function innertubeSignedIn(c) { return isInnertubeMode(c) && typeof c.config.tvRefreshToken === 'string' && c.config.tvRefreshToken.length > 0; }
export const SIGN_IN_REQUIRED = 'Sign in with Google on this screen from YouTube settings to see your Home feed, subscriptions and history.';
export const RECONNECT_REQUIRED = 'Google authorization for YouTube has expired or was revoked. Open Connections and sign in on this screen again.';

/** "3 days ago" style text to an ISO date, so feeds sort newest first alongside Data API items. */
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

/** Choose a progressive H.264 video stream at or below the ceiling plus an AAC audio stream. */
export function chooseStreams(streamingData, { maxHeight = 1080 } = {}) {
  const formats = [...(streamingData?.adaptive_formats || []), ...(streamingData?.formats || [])].filter(f => f && typeof f.mime_type === 'string' && !f.drm_families?.length && !f.is_type_otf);
  const videos = formats.filter(f => f.has_video && !f.has_audio && /avc1/i.test(f.mime_type) && (f.height || 0) <= maxHeight && (f.url || f.signature_cipher || f.cipher))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  const audios = formats.filter(f => f.has_audio && !f.has_video && /mp4a/i.test(f.mime_type) && (f.url || f.signature_cipher || f.cipher) && (!f.audio_track || f.audio_track.audio_is_default) && !f.is_drc)
    .sort((a, b) => Number(b.itag === 140) - Number(a.itag === 140) || (b.bitrate || 0) - (a.bitrate || 0));
  return videos[0] && audios[0] ? { video: videos[0], audio: audios[0] } : null;
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
  createInnertube, cacheFactory, maxHeight = 1080, pageLifetime = 15 * 60000, requestTimeout = 25000,
  probe = defaultProbe, visitorData = fetchVisitorData, visitorLifetime = 6 * 3600000,
} = {}) {
  const pending = new Map(); // connectionId -> device authorization in progress
  const clients = new Map(); // connectionId -> { key, promise }
  const pages = new Map(); // continuation token -> { feed, userId, connectionId, expires, map }
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
    library ??= import('youtubei.js');
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
    clients.delete(c.id);
    saveConfig(req, c, {
      authMode: 'innertube', tvAccessToken: data.access_token, tvRefreshToken: data.refresh_token, tvExpiresAt: now() + Number(data.expires_in || 3600) * 1000, tvScope: entry.scope,
      // Tokens belong to the client that issued them; keep YouTube's client beside them for refreshes.
      tvBuiltinClientId: client.kind === 'youtube' ? client.clientId : null, tvBuiltinClientSecret: client.kind === 'youtube' ? client.clientSecret : null,
    });
    return { status: 'authorized' };
  }
  function cancelSignIn(req, c) { const entry = pending.get(c.id); if (entry && entry.userId === req.user.id) pending.delete(c.id); }
  async function signOut(req, c) {
    if (c.shared) throw providerError('Only the connection owner can sign out of this shared connection.', 403);
    cancelSignIn(req, c); clients.delete(c.id);
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
  async function signedClient(req, c) {
    const token = await accessToken(req, c);
    const key = createHash('sha256').update(`${token.refreshToken}:${token.client.clientId}`).digest('hex');
    let entry = clients.get(c.id);
    if (!entry || entry.key !== key) {
      const promise = (async () => {
        // YouTube only honours the TV app's tokens on InnerTube requests made as the TV client.
        const yt = await build({ client_type: 'TVHTML5' });
        yt.session.on?.('update-credentials', ({ credentials }) => {
          if (credentials?.access_token) { try { saveConfig(req, c, { tvAccessToken: credentials.access_token, tvExpiresAt: Date.parse(credentials.expiry_date) || now() + 3600000 }); } catch (error) { log.warn?.('YouTube token save failed', error.message); } }
        });
        yt.session.on?.('auth-error', error => log.warn?.('YouTube auth error', error?.message));
        await yt.session.signIn(tokenSet(token));
        return yt;
      })();
      entry = { key, promise };
      clients.set(c.id, entry);
      promise.catch(() => { if (clients.get(c.id) === entry) clients.delete(c.id); });
    }
    const yt = await entry.promise;
    if (yt.session.oauth?.oauth2_tokens && yt.session.oauth.oauth2_tokens.access_token !== token.accessToken) yt.session.oauth.setTokens(tokenSet(token));
    return yt;
  }
  async function anonymousClient(renew = false) {
    if (!anonymous || renew || anonymousExpires < now()) {
      anonymousExpires = now() + visitorLifetime;
      anonymous = (async () => build({ visitor_data: await visitorData() }))();
      anonymous.catch(() => { anonymous = null; });
    }
    return anonymous;
  }
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
  /** Direct H.264 + AAC stream URLs for TesPlayer's dual-input path, or null when InnerTube cannot supply them. */
  async function resolve(req, c, videoId, signal) {
    if (!VIDEO_ID.test(String(videoId))) throw providerError('Enter a valid YouTube video ID.', 400);
    const attempts = [];
    if (c && innertubeSignedIn(c)) attempts.push({ client: 'TV', open: () => signedClient(req, c) });
    attempts.push({ client: 'VISIONOS', open: () => anonymousClient(), renew: () => anonymousClient(true) });
    let lastReason = '';
    for (const attempt of attempts) {
      if (signal?.aborted) throw signal.reason;
      try {
        let yt = await attempt.open();
        let info = await timed(yt.getBasicInfo(videoId, { client: attempt.client }));
        let status = info.playability_status?.status;
        if (status === 'LOGIN_REQUIRED' && attempt.renew) {
          // Stale visitor data trips the bot check; mint fresh visitor data once and retry.
          yt = await attempt.renew();
          info = await timed(yt.getBasicInfo(videoId, { client: attempt.client }));
          status = info.playability_status?.status;
        }
        if (info.basic_info?.is_live || info.basic_info?.is_upcoming) return { isLive: true, info: info.basic_info };
        if (status && status !== 'OK') { lastReason = `${attempt.client}: ${status} ${info.playability_status?.reason || ''}`.trim(); continue; }
        const chosen = chooseStreams(info.streaming_data, { maxHeight });
        if (!chosen) { lastReason = `${attempt.client}: no progressive H.264/AAC formats (SABR only)`; continue; }
        const endpoint = async format => {
          const url = validateRemoteUrl(await format.decipher(yt.session.player));
          if (url.protocol !== 'https:' || !/(?:^|\.)googlevideo\.com$/.test(url.hostname)) throw new Error('unexpected stream host');
          return { url: url.href, headers: {}, hls: false, itag: format.itag, height: format.height, mimeType: format.mime_type };
        };
        const [video, audio] = await Promise.all([endpoint(chosen.video), endpoint(chosen.audio)]);
        // Without a proof-of-origin token some clients get URLs that only serve the first megabyte.
        // Read a slice from the middle of each file before handing the URLs to the player.
        const usable = (await Promise.all([video, audio].map(stream => probe(stream.url, chosen.video === stream ? chosen.video.content_length : chosen.audio.content_length)))).every(Boolean);
        if (!usable) { lastReason = `${attempt.client}: videoplayback refused a mid-file range (proof-of-origin token required)`; continue; }
        return { video, audio, isLive: false, via: `innertube-${attempt.client.toLowerCase()}`, title: text(info.basic_info?.title) };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error?.status === 409 && attempt.client === 'TV') { lastReason = 'TV: not signed in'; continue; }
        if (attempt.client !== 'TV') anonymous = null;
        lastReason = `${attempt.client}: ${String(error?.message || error).slice(0, 200)}`;
      }
    }
    log.warn?.(`YouTube InnerTube could not resolve ${videoId} (${lastReason}); falling back to yt-dlp.`);
    return null;
  }
  return { mode: isInnertubeMode, signedIn: innertubeSignedIn, configured, startSignIn, signInStatus, cancelSignIn, signOut, home, subscriptionsFeed, history, channels, playlists, search, channelVideos, playlistVideos, test, resolve,
    _internal: { pending, pages, clients } };
}

/** Express routes under /api/youtube/:connectionId for InnerTube-mode connections. Registered before the Data API routes; non-InnerTube connections fall through. */
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
  app.get(root + '/home', only(async (req, res, c) => res.json(withArt(req, c, await service.home(req, c, token(req))))));
  app.get(root + '/history', only(async (req, res, c) => res.json(withArt(req, c, await service.history(req, c, token(req))))));
  app.get(root + '/feed', only(async (req, res, c) => res.json({ ...withArt(req, c, await service.subscriptionsFeed(req, c, token(req))), channelRows: [], basis: 'subscriptions' })));
  app.get(root + '/subscriptions', only(async (req, res, c) => res.json(withArt(req, c, await service.channels(req, c, token(req))))));
  app.get(root + '/playlists', only(async (req, res, c) => res.json(withArt(req, c, await service.playlists(req, c, token(req))))));
  app.get(root + '/search', only(async (req, res, c) => res.json(withArt(req, c, await service.search(req, c, req.query.q, token(req))))));
  app.get(root + '/channel/:channelId/videos', only(async (req, res, c) => res.json(withArt(req, c, await service.channelVideos(req, c, req.params.channelId, token(req))))));
  app.get(root + '/playlist/:playlistId/videos', only(async (req, res, c) => res.json(withArt(req, c, await service.playlistVideos(req, c, req.params.playlistId, token(req))))));
}
