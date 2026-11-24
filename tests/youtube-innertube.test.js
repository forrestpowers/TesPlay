import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {
  createInnertubeService, registerInnertubeRoutes, videoItem, channelItem, playlistItem, chooseStreams, audioRank, relativeDate, clockDuration, rawTvPage, TV_SCOPES, SIGN_IN_REQUIRED,
} from '../server/youtube-innertube.js';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const run = v => ({ toString: () => v, runs: [{ text: v }] });
const lockup = (id, title, parts = [], { type = 'VIDEO', badge = '12:34', image = 'https://i.ytimg.com/vi/x/hq720.jpg' } = {}) => ({
  type: 'LockupView', content_id: id, content_type: type,
  metadata: { title: run(title), metadata: { metadata_rows: [{ metadata_parts: parts.map(p => ({ text: typeof p === 'string' ? run(p) : p })) }] } },
  content_image: { image: [{ url: image, width: 720 }, { url: image.replace('hq720', 'mq'), width: 320 }], overlays: [{ badges: [{ text: badge }] }] },
  duration: { text: badge, seconds: clockDuration(badge) || 0 },
});
const rawTile = (id, title, lines, { type = 'VIDEO', badge = '12:34', thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } = {}) => ({ tileRenderer: {
  contentId: id, contentType: `TILE_CONTENT_TYPE_${type}`,
  header: { tileHeaderRenderer: { thumbnail: { thumbnails: [{ url: thumb, width: 480, height: 360 }] }, thumbnailOverlays: [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 10 } }, { thumbnailOverlayTimeStatusRenderer: { text: { simpleText: badge }, style: badge === 'LIVE' ? 'LIVE' : 'DEFAULT' } }] } },
  metadata: { tileMetadataRenderer: { title: { simpleText: title }, lines: lines.map(parts => ({ lineRenderer: { items: parts.map(p => ({ lineItemRenderer: { text: typeof p === 'string' ? { simpleText: p } : { runs: [{ text: p.run }] } } })) } })) } },
} });
const tvResponse = (tiles, continuation) => ({ contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { gridRenderer: { items: tiles, ...(continuation ? { continuations: [{ nextContinuationData: { continuation } }] } : {}) } } } } } } });
const format = (itag, mime, extra = {}) => ({ itag, mime_type: mime, has_video: mime.startsWith('video'), has_audio: mime.startsWith('audio'), url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=${itag}`, bitrate: 1000 * itag, ...extra, decipher: async () => `https://rr1---sn-test.googlevideo.com/videoplayback?itag=${itag}&n=ok` });
const streaming = (heights = [1080, 720, 2160]) => ({ adaptive_formats: [
  ...heights.map(h => format(h === 2160 ? 313 : h === 1080 ? 137 : 136, h === 2160 ? 'video/webm; codecs="vp9"' : 'video/mp4; codecs="avc1.640028"', { height: h, fps: 30 })),
  format(140, 'audio/mp4; codecs="mp4a.40.2"'), format(251, 'audio/webm; codecs="opus"'), format(139, 'audio/mp4; codecs="mp4a.40.5"', { bitrate: 48000 }),
] });

test('item mappers read youtubei.js nodes into MediaItem shapes and reject malformed ids', () => {
  const classic = videoItem({ type: 'Video', video_id: 'aqz-KE-bpKQ', title: run('Big Buck Bunny'), author: { id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender' }, thumbnails: [{ url: '//i.ytimg.com/vi/aqz-KE-bpKQ/hq720.jpg', width: 720 }], duration: { seconds: 635 }, published: run('13 days ago'), is_live: false, description_snippet: run('An <b>open</b> movie') }, { connectionId: 'c1' }, NOW);
  assert.deepEqual(classic, { id: 'aqz-KE-bpKQ', connectionId: 'c1', source: 'YouTube', providerType: 'youtube', type: 'video', title: 'Big Buck Bunny', description: 'An open movie', poster: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hq720.jpg', subtitle: 'Blender', categoryLabel: 'Blender', channelId: 'UCSMOQeBJ2RAnuFungnQOxLg', duration: 635, publishedAt: '2026-11-10T12:00:00.000Z' });
  const channelPage = videoItem(lockup('pvUy69I_Xuk', "What's New", ['322K views', '2 weeks ago'], { badge: '28:01' }), { connectionId: 'c1', channel: { id: 'UCSMOQeBJ2RAnuFungnQOxLg', title: 'Blender' } }, NOW);
  assert.equal(channelPage.subtitle, 'Blender'); assert.equal(channelPage.channelId, 'UCSMOQeBJ2RAnuFungnQOxLg'); assert.equal(channelPage.duration, 1681); assert.equal(channelPage.publishedAt, '2026-11-09T12:00:00.000Z');
  assert.equal(channelPage.poster, 'https://i.ytimg.com/vi/x/hq720.jpg');
  const author = { ...run('Blender'), runs: [{ text: 'Blender', endpoint: { payload: { browseId: 'UCSMOQeBJ2RAnuFungnQOxLg' } } }] };
  const playlistVideo = videoItem(lockup('MF1qEhBSfq4', 'First Steps', [author, '4.4M views']), {}, NOW);
  assert.equal(playlistVideo.subtitle, 'Blender'); assert.equal(playlistVideo.channelId, 'UCSMOQeBJ2RAnuFungnQOxLg'); assert.equal(playlistVideo.duration, 754);
  assert.equal(videoItem(lockup('MF1qEhBSfq4', 'Clip', [], { type: 'SHORT' }), {}, NOW).contentKind, 'short');
  assert.equal(videoItem({ type: 'ShortsLockupView', on_tap_endpoint: { payload: { videoId: 'MF1qEhBSfq4' } }, overlay_metadata: { primary_text: run('A short') } }, {}, NOW).contentKind, 'short');
  assert.equal(videoItem({ type: 'Video', video_id: 'MF1qEhBSfq4', title: run('Live now'), is_live: true }, {}, NOW).contentKind, 'live');
  assert.equal(videoItem({ type: 'Video', video_id: 'short', title: run('bad') }, {}, NOW), null);
  assert.equal(videoItem({ type: 'Video', video_id: 'MF1qEhBSfq4', title: run('[Private video]') }, {}, NOW), null);
  assert.equal(videoItem(lockup('MF1qEhBSfq4', 'Not a video', [], { type: 'PLAYLIST' }), {}, NOW), null);
  assert.equal(videoItem({ type: 'Video', video_id: 'MF1qEhBSfq4', title: run('http thumb'), thumbnails: [{ url: 'http://evil.example/x.jpg', width: 9 }] }, {}, NOW).poster, 'https://i.ytimg.com/vi/MF1qEhBSfq4/hqdefault.jpg');
  const channel = channelItem({ type: 'Channel', author: { id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender', thumbnails: [{ url: '//yt3.ggpht.com/a', width: 88 }] }, subscriber_count: run('1.2M subscribers'), video_count: run('1,234 videos') });
  assert.deepEqual(channel, { id: 'UCSMOQeBJ2RAnuFungnQOxLg', title: 'Blender', description: '', thumbnail: 'https://yt3.ggpht.com/a', videoCount: 1234, subtitle: '1,234 videos' });
  assert.equal(channelItem({ type: 'Channel', author: { id: 'not-a-channel', name: 'x' } }), null);
  const playlist = playlistItem({ ...lockup('PLa1F2ddGya_-UvuAqHAksYnB0qL9yWDO6', 'Fundamentals', [], { type: 'PLAYLIST', badge: '43 videos' }) });
  assert.equal(playlist.id, 'PLa1F2ddGya_-UvuAqHAksYnB0qL9yWDO6'); assert.equal(playlist.videoCount, 43); assert.equal(playlist.title, 'Fundamentals');
  assert.equal(playlistItem({ type: 'GridPlaylist', id: 'aqz-KE-bpKQ', title: run('looks like a video id') }), null);
  assert.equal(relativeDate('Streamed 3 hours ago', NOW), '2026-11-23T09:00:00.000Z');
  assert.equal(relativeDate('in 2 hours', NOW), undefined);
  assert.equal(clockDuration('1:02:03'), 3723); assert.equal(clockDuration('LIVE'), undefined);
});

test('the service defaults to a 720p ceiling for the car and honours YOUTUBE_MAX_HEIGHT', async () => {
  const seen = [];
  const service = createInnertubeService({ getConnection: () => null, saveConfig: () => {}, env: {}, createInnertube: async () => ({ session: { on() {}, signIn: async () => {}, oauth: {}, player: {} }, getBasicInfo: async () => ({ playability_status: { status: 'OK' }, basic_info: {}, streaming_data: streaming([1080, 720]) }) }), visitorData: async () => 'v', probe: async () => true, log: { warn: () => {} } });
  assert.equal((await service.resolve({ user: { id: 'o' } }, { id: 'c', type: 'youtube', config: {} }, 'aqz-KE-bpKQ')).video.height, 720);
  const tall = createInnertubeService({ getConnection: () => null, saveConfig: () => {}, env: { YOUTUBE_MAX_HEIGHT: '1080' }, createInnertube: async () => ({ session: { on() {}, signIn: async () => {}, oauth: {}, player: {} }, getBasicInfo: async () => ({ playability_status: { status: 'OK' }, basic_info: {}, streaming_data: streaming([1080, 720]) }) }), visitorData: async () => 'v', probe: async () => true, log: { warn: () => {} } });
  assert.equal((await tall.resolve({ user: { id: 'o' } }, { id: 'c', type: 'youtube', config: {} }, 'aqz-KE-bpKQ')).video.height, 1080);
  void seen;
});

test('chooseStreams picks the best H.264 track at or below 1080p with AAC itag 140 and refuses DRM or SABR-only data', () => {
  const chosen = chooseStreams(streaming());
  assert.equal(chosen.video.itag, 137); assert.equal(chosen.video.height, 1080); assert.equal(chosen.audio.itag, 140);
  const sixty = streaming(); sixty.adaptive_formats.push(format(299, 'video/mp4; codecs="avc1.64002a"', { height: 1080, fps: 60, bitrate: 299000 }));
  assert.equal(chooseStreams(sixty).video.itag, 137, '30 fps is preferred over 60 fps at the same height');
  const onlySixtyAt1080 = streaming([720, 2160]); onlySixtyAt1080.adaptive_formats.push(format(299, 'video/mp4; codecs="avc1.64002a"', { height: 1080, fps: 60, bitrate: 299000 }));
  assert.equal(chooseStreams(onlySixtyAt1080).video.itag, 136, '720p30 beats 1080p60, as the TV app chooses on a car');
  assert.equal(chooseStreams(streaming(), { maxHeight: 720 }).video.itag, 136);
  const sabr = streaming(); sabr.adaptive_formats.forEach(f => { delete f.url; });
  assert.equal(chooseStreams(sabr), null);
  const drm = streaming(); drm.adaptive_formats.forEach(f => { f.drm_families = ['widevine']; });
  assert.equal(chooseStreams(drm), null);
  const noAac = streaming(); noAac.adaptive_formats = noAac.adaptive_formats.filter(f => !/mp4a/.test(f.mime_type));
  assert.equal(chooseStreams(noAac), null);
  // Dubbed videos: several itag 140 tracks; the original wins even when a dub is marked default.
  const dubbed = streaming();
  dubbed.adaptive_formats = dubbed.adaptive_formats.filter(f => f.itag !== 140).concat([
    { ...format(140, 'audio/mp4; codecs="mp4a.40.2"'), audio_track: { id: 'es.4', display_name: 'Spanish', audio_is_default: true }, is_dubbed: true, language: 'es' },
    { ...format(140, 'audio/mp4; codecs="mp4a.40.2"'), audio_track: { id: 'fr.10', display_name: 'French (auto)', audio_is_default: false }, is_auto_dubbed: true, language: 'fr' },
    { ...format(140, 'audio/mp4; codecs="mp4a.40.2"'), audio_track: { id: 'en.4', display_name: 'English original', audio_is_default: false }, is_original: true, language: 'en' },
  ]);
  assert.equal(chooseStreams(dubbed).audio.language, 'en');
  const sabrLike = [
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', hasAudio: true, bitrate: 130000, audioTrackId: 'de.4', isDubbed: true, language: 'de' },
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', hasAudio: true, bitrate: 130000, audioTrackId: 'en.4', isOriginal: true, language: 'en' },
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', hasAudio: true, bitrate: 130000, audioTrackId: 'pt.10', isAutoDubbed: true, language: 'pt' },
  ];
  assert.deepEqual(sabrLike.map(audioRank), [4, 0, 4]);
  assert.equal(audioRank({ itag: 140, hasAudio: true }), 1, 'a single-track video has no track id and counts as the default');
  // Three copies of the original: compressed, plain, voice-boosted. Plain wins.
  const copies = streaming();
  copies.adaptive_formats = copies.adaptive_formats.filter(f => f.itag !== 140).concat([
    { ...format(140, 'audio/mp4; codecs="mp4a.40.2"'), is_original: true, is_drc: true, xtags: 'drc' },
    { ...format(140, 'audio/mp4; codecs="mp4a.40.2"'), is_original: true, xtags: 'plain' },
    { ...format(140, 'audio/mp4; codecs="mp4a.40.2"'), is_original: true, is_vb: true, xtags: 'vb' },
  ]);
  assert.equal(chooseStreams(copies).audio.xtags, 'plain');
  const surround = streaming();
  surround.adaptive_formats.push({ ...format(258, 'audio/mp4; codecs="mp4a.40.2"'), audio_channels: 6, bitrate: 384000 });
  assert.equal(chooseStreams(surround).audio.itag, 140, 'stereo is preferred over a louder 5.1 track');
});

function fixture({ config = {}, info, fetchResponses = [], probe = async () => true, visitors = ['visitor-1', 'visitor-2'], potProviderUrl = '' } = {}) {
  const connections = new Map([['c1', { id: 'c1', type: 'youtube', name: 'YouTube', config: { authMode: 'innertube', tvClientId: 'tv-client', tvClientSecret: 'tv-secret', ...config } }]]);
  const saved = [];
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    const raw = String(init?.body || '');
    fetchCalls.push({ url: String(url), json: raw.startsWith('{'), body: raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) });
    if (String(url).endsWith('/get_pot')) return { ok: true, status: 200, json: async () => ({ poToken: `pot-for-${JSON.parse(raw).content_binding}`, contentBinding: JSON.parse(raw).content_binding, expiresAt: new Date(NOW + 6 * 3600000).toISOString() }) };
    const next = fetchResponses.shift() || { status: 500, body: { error: 'unexpected' } };
    return { ok: next.status < 300, status: next.status, json: async () => next.body };
  };
  const created = [];
  const feedOf = (videos, more) => ({ videos, channels: [], playlists: [], has_continuation: !!more, getContinuation: async () => feedOf(more, null) });
  const createInnertube = async (options = {}) => {
    const events = {};
    const yt = { options,
      session: { on: (name, fn) => { events[name] = fn; }, signIn: async tokens => { yt.session.oauth.oauth2_tokens = tokens; yt.session.logged_in = true; }, oauth: { oauth2_tokens: null, setTokens(t) { this.oauth2_tokens = t; }, getClientID: async () => ({ client_id: 'yt-tv-client.apps.googleusercontent.com', client_secret: 'yt-tv-secret' }) }, player: { id: 'p' }, logged_in: false },
      calls: [], events,
      getBasicInfo: async (id, options) => { yt.calls.push(['getBasicInfo', id, options.client]); return info(options.client, yt); },
      browses: [],
      actions: { execute: async (endpoint, args) => {
        yt.browses.push({ endpoint, args });
        const pages = {
          FEwhat_to_watch: tvResponse([rawTile('aqz-KE-bpKQ', 'Home one', [[{ run: 'Blender' }], ['9.7K views', '3 days ago']], { badge: '10:35' })], 'home-page-2'),
          'home-page-2': tvResponse([rawTile('MF1qEhBSfq4', 'Home two', [['Blender'], ['1K views']])]),
          FEsubscriptions: tvResponse([rawTile('MF1qEhBSfq4', 'New upload', [['Scott Manley'], ['111K views', '1 day ago']]), rawTile('pvUy69I_Xuk', 'A short', [['Someone']], { type: 'SHORTS', badge: '0:45' })]),
          FEhistory: tvResponse([rawTile('aqz-KE-bpKQ', 'Watched', [['Blender'], ['49 watching']], { badge: 'LIVE' })]),
          FEchannels: tvResponse([rawTile('UCSMOQeBJ2RAnuFungnQOxLg', 'Blender', [['@BlenderOfficial'], ['1.73M subscribers']], { type: 'CHANNEL', thumb: '//yt3.googleusercontent.com/avatar=s176' })]),
          FEplaylist_aggregation: tvResponse([rawTile('WL', 'Watch later', [['Private']], { type: 'PLAYLIST', badge: '33 videos' }), rawTile('PLa1F2ddGya_-UvuAqHAksYnB0qL9yWDO6', 'Fundamentals', [['Blender']], { type: 'PLAYLIST', badge: '43 videos' })]),
          VLWL: tvResponse([rawTile('MF1qEhBSfq4', 'Lesson 1', [['ThoracicSurgeons'], ['2 years ago']])]),
          UCSMOQeBJ2RAnuFungnQOxLg: tvResponse([rawTile('pvUy69I_Xuk', 'Channel reel', [['Blender']])]),
        };
        const data = pages[args.continuation || args.browseId] || tvResponse([]);
        return { data: Promise.resolve(data) };
      } },
      search: async (q, filters) => filters?.type === 'video' ? feedOf([{ type: 'Video', video_id: 'aqz-KE-bpKQ', title: run(`Result for ${q}`) }]) : { ...feedOf([]), channels: [{ type: 'Channel', author: { id: 'UCSMOQeBJ2RAnuFungnQOxLg', name: 'Blender' } }] },
      getChannel: async id => ({ has_videos: true, metadata: { title: 'Blender' }, getVideos: async () => feedOf([lockup('pvUy69I_Xuk', 'Channel upload', ['1K views', '2 days ago'])]) }),
    };
    created.push(yt);
    return yt;
  };
  const service = createInnertubeService({
    getConnection: (_req, id) => connections.get(id), saveConfig: (_req, c, patch) => { saved.push(patch); const current = connections.get(c.id); current.config = { ...current.config, ...patch }; },
    env: {}, fetchImpl, now: () => NOW, createInnertube, log: { warn: () => {} }, requestTimeout: 2000, probe, visitorData: async () => visitors.shift() || 'visitor-n', potProviderUrl, maxHeight: 1080,
  });
  return { service, connections, saved, fetchCalls, created, req: { user: { id: 'owner' } } };
}

test('device sign-in: start requests a code with the TV scopes, status polls Google and saves encrypted-config tokens once approved', async () => {
  const f = fixture({ config: { tvRefreshToken: undefined }, fetchResponses: [
    { status: 400, body: { error: 'invalid_scope' } },
    { status: 200, body: { device_code: 'dev', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 } },
    { status: 428, body: { error: 'authorization_pending' } },
    { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
  ] });
  const c = f.connections.get('c1');
  const start = await f.service.startSignIn(f.req, c);
  assert.deepEqual(start, { status: 'pending', userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device', expiresAt: new Date(NOW + 1800000).toISOString(), interval: 5 });
  assert.deepEqual(f.fetchCalls.map(x => x.body.scope), TV_SCOPES);
  assert.equal((await f.service.signInStatus(f.req, c)).status, 'pending');
  assert.equal(f.fetchCalls.length, 3);
  assert.equal(f.fetchCalls[2].body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  // Polling again inside Google's interval does not hit Google.
  assert.equal((await f.service.signInStatus(f.req, c)).status, 'pending');
  assert.equal(f.fetchCalls.length, 3);
  f.service._internal.pending.get('c1').nextPoll = 0;
  assert.deepEqual(await f.service.signInStatus(f.req, c), { status: 'authorized' });
  assert.deepEqual(f.saved.at(-1), { authMode: 'innertube', tvAccessToken: 'at', tvRefreshToken: 'rt', tvExpiresAt: NOW + 3600000, tvScope: TV_SCOPES[1], tvBuiltinClientId: null, tvBuiltinClientSecret: null });
  assert.ok(f.service.signedIn(f.connections.get('c1')));
  // Another user cannot read the owner's pending code.
  assert.equal((await f.service.signInStatus({ user: { id: 'other' } }, c)).status, 'authorized');
});

test('device sign-in reports denied and expired codes and rejects an unknown client', async () => {
  const f = fixture({ fetchResponses: [
    { status: 200, body: { device_code: 'dev', user_code: 'X', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 } },
    { status: 403, body: { error: 'access_denied' } },
    { status: 401, body: { error: 'invalid_client' } },
  ] });
  const c = f.connections.get('c1');
  await f.service.startSignIn(f.req, c);
  assert.deepEqual(await f.service.signInStatus(f.req, c), { status: 'denied' });
  await assert.rejects(f.service.startSignIn(f.req, c), { status: 409 });
  await assert.rejects(f.service.startSignIn(f.req, { ...c, shared: true }), { status: 403 });
});

test("without a custom client the sign-in uses YouTube's own TV-app client through youtube.com's OAuth endpoints and keeps it for refreshes", async () => {
  const f = fixture({ config: { tvClientId: undefined, tvClientSecret: undefined }, fetchResponses: [
    { status: 200, body: { device_code: 'dev', user_code: 'WXYZ-1234', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 } },
    { status: 200, body: { error_code: 'authorization_pending' } },
    { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
    { status: 200, body: { access_token: 'at2', expires_in: 3600 } },
  ] });
  const c = f.connections.get('c1');
  assert.equal(f.service.configured(c), false);
  const start = await f.service.startSignIn(f.req, c);
  assert.equal(start.userCode, 'WXYZ-1234');
  assert.equal(start.verificationUrl, 'https://www.google.com/device');
  assert.equal(f.fetchCalls[0].url, 'https://www.youtube.com/o/oauth2/device/code');
  assert.ok(f.fetchCalls[0].json);
  assert.equal(f.fetchCalls[0].body.client_id, 'yt-tv-client.apps.googleusercontent.com');
  assert.equal(f.fetchCalls[0].body.scope, TV_SCOPES[0]);
  assert.equal(f.fetchCalls[0].body.device_model, 'ytlr::');
  assert.equal(f.created.length, 1, 'one lightweight client reads the TV client identity');
  assert.equal(f.created[0].options.retrieve_player, false);
  assert.equal((await f.service.signInStatus(f.req, c)).status, 'pending');
  assert.equal(f.fetchCalls[1].url, 'https://www.youtube.com/o/oauth2/token');
  assert.deepEqual(f.fetchCalls[1].body, { client_id: 'yt-tv-client.apps.googleusercontent.com', client_secret: 'yt-tv-secret', code: 'dev', grant_type: 'http://oauth.net/grant_type/device/1.0' });
  f.service._internal.pending.get('c1').nextPoll = 0;
  assert.deepEqual(await f.service.signInStatus(f.req, c), { status: 'authorized' });
  assert.equal(f.saved.at(-1).tvBuiltinClientId, 'yt-tv-client.apps.googleusercontent.com');
  assert.equal(f.saved.at(-1).tvBuiltinClientSecret, 'yt-tv-secret');
  // Refreshing later uses the remembered client without reading youtube.com/tv again.
  c.config.tvExpiresAt = 0;
  await f.service.home(f.req, c);
  assert.equal(f.fetchCalls[3].url, 'https://www.youtube.com/o/oauth2/token');
  assert.equal(f.fetchCalls[3].body.grant_type, 'refresh_token');
  assert.equal(f.fetchCalls[3].body.client_secret, 'yt-tv-secret');
  assert.equal(f.created.length, 2);
  await f.service.signOut(f.req, c);
  assert.equal(f.saved.at(-1).tvBuiltinClientId, null);
});

test('browsing uses one signed-in TV client per connection, refreshes expired tokens through Google and pages through TV continuations', async () => {
  const f = fixture({ config: { tvAccessToken: 'stale', tvRefreshToken: 'rt', tvExpiresAt: NOW - 1 }, fetchResponses: [{ status: 200, body: { access_token: 'fresh', expires_in: 3600 } }] });
  const c = f.connections.get('c1');
  const home = await f.service.home(f.req, c);
  assert.deepEqual(home.items.map(i => i.id), ['aqz-KE-bpKQ']);
  assert.equal(home.items[0].subtitle, 'Blender');
  assert.equal(home.items[0].duration, 635);
  assert.equal(home.items[0].publishedAt, '2026-11-20T12:00:00.000Z');
  assert.equal(home.items[0].poster, 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg');
  assert.equal(f.created[0].options.client_type, 'TVHTML5', 'the TV app token only works on TV-client requests');
  assert.deepEqual(f.created[0].browses[0], { endpoint: '/browse', args: { browseId: 'FEwhat_to_watch' } });
  assert.ok(home.nextPageToken);
  assert.equal(f.fetchCalls[0].body.grant_type, 'refresh_token');
  assert.deepEqual(f.saved[0], { tvAccessToken: 'fresh', tvExpiresAt: NOW + 3600000 });
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].session.oauth.oauth2_tokens.access_token, 'fresh');
  assert.deepEqual(f.created[0].session.oauth.oauth2_tokens.client, { client_id: 'tv-client', client_secret: 'tv-secret' });
  const page2 = await f.service.home(f.req, c, home.nextPageToken);
  assert.deepEqual(page2.items.map(i => i.id), ['MF1qEhBSfq4']);
  assert.deepEqual(f.created[0].browses[1], { endpoint: '/browse', args: { continuation: 'home-page-2' } });
  assert.equal(page2.nextPageToken, null);
  await assert.rejects(f.service.home(f.req, c, home.nextPageToken), { status: 410 });
  await assert.rejects(f.service.home({ user: { id: 'other' } }, c, 'nope'), { status: 410 });
  const latest = await f.service.subscriptionsFeed(f.req, c);
  assert.equal(latest.items[0].publishedAt, '2026-11-22T12:00:00.000Z');
  assert.equal(latest.items[0].subtitle, 'Scott Manley');
  assert.equal(latest.items[1].contentKind, 'short');
  const watched = (await f.service.history(f.req, c)).items[0];
  assert.equal(watched.title, 'Watched'); assert.equal(watched.contentKind, 'live'); assert.equal(watched.duration, undefined);
  const channelsPage = await f.service.channels(f.req, c);
  assert.deepEqual(channelsPage.channels, [{ id: 'UCSMOQeBJ2RAnuFungnQOxLg', title: 'Blender', description: '', thumbnail: 'https://yt3.googleusercontent.com/avatar=s176', subtitle: '1.73M subscribers' }]);
  assert.deepEqual((await f.service.playlists(f.req, c)).playlists, [
    { id: 'WL', title: 'Watch later', thumbnail: 'https://i.ytimg.com/vi/WL/hqdefault.jpg', videoCount: 33 },
    { id: 'PLa1F2ddGya_-UvuAqHAksYnB0qL9yWDO6', title: 'Fundamentals', thumbnail: 'https://i.ytimg.com/vi/PLa1F2ddGya_-UvuAqHAksYnB0qL9yWDO6/hqdefault.jpg', videoCount: 43 },
  ]);
  const search = await f.service.search(f.req, c, '  blender ');
  assert.equal(search.items[0].title, 'Result for blender'); assert.equal(search.channels.length, 1);
  assert.deepEqual(await f.service.search(f.req, c, ''), { items: [], channels: [], nextPageToken: null });
  const channel = await f.service.channelVideos(f.req, c, 'UCSMOQeBJ2RAnuFungnQOxLg');
  assert.equal(channel.items[0].title, 'Channel upload', 'public channel uploads come from the anonymous web client, newest first');
  assert.equal(channel.items[0].subtitle, 'Blender'); assert.equal(channel.items[0].channelId, 'UCSMOQeBJ2RAnuFungnQOxLg');
  assert.equal(f.created.length, 2, 'channel pages use the anonymous client');
  await assert.rejects(f.service.channelVideos(f.req, c, 'bad'), { status: 400 });
  const lesson = (await f.service.playlistVideos(f.req, c, 'WL')).items[0];
  assert.equal(lesson.title, 'Lesson 1'); assert.equal(lesson.subtitle, 'ThoracicSurgeons');
  assert.equal(f.fetchCalls.length, 1);
});

test('with a proof-of-origin token provider the anonymous client carries a token bound to its visitor data', async () => {
  let calls = 0;
  const f = fixture({ potProviderUrl: 'http://pot:4416/', info: (_client, yt) => ({ playability_status: { status: yt.options.visitor_data === 'visitor-2' ? 'OK' : 'LOGIN_REQUIRED', reason: '' }, basic_info: {}, streaming_data: yt.options.visitor_data === 'visitor-2' ? streaming() : undefined }) });
  assert.equal(f.service.potConfigured(), true);
  const resolved = await f.service.resolve(f.req, { id: 'c2', type: 'youtube', config: { apiKey: 'k' } }, 'aqz-KE-bpKQ');
  assert.equal(resolved.via, 'innertube-visionos');
  assert.equal(f.fetchCalls[0].url, 'http://pot:4416/get_pot');
  assert.deepEqual(f.fetchCalls[0].body, { content_binding: 'visitor-1' });
  assert.equal(f.created[0].options.visitor_data, 'visitor-1');
  assert.equal(f.created[0].options.po_token, 'pot-for-visitor-1');
  // The bot check renews the visitor data and its token once, then visionOS succeeds.
  assert.deepEqual(f.created.map(yt => yt.options.po_token), ['pot-for-visitor-1', 'pot-for-visitor-2']);
  assert.equal(f.fetchCalls.length, 2, 'one token per visitor data');
  void calls;
  const none = fixture({ info: () => ({ playability_status: { status: 'LOGIN_REQUIRED' }, basic_info: {} }) });
  assert.equal(none.service.potConfigured(), false);
  assert.equal(await none.service.resolve(none.req, { id: 'c2', type: 'youtube', config: {} }, 'aqz-KE-bpKQ'), null, 'without a provider only visionOS is tried');
  assert.ok(none.created.every(yt => !yt.options.po_token));
});

test('rawTvPage reads tiles and continuation tokens out of a TV browse response', () => {
  const page = rawTvPage(tvResponse([rawTile('aqz-KE-bpKQ', 'Tile <b>title</b>', [[{ run: 'Author' }], ['1 view']], { badge: '1:00:00' })], 'next-token'));
  assert.equal(page.continuation, 'next-token');
  assert.equal(page.tiles.length, 1);
  const item = videoItem(page.tiles[0], { connectionId: 'c1' }, NOW);
  assert.equal(item.title, 'Tile title'); assert.equal(item.subtitle, 'Author'); assert.equal(item.duration, 3600);
  assert.deepEqual(rawTvPage({ contents: {} }), { tiles: [], continuation: null });
  assert.equal(rawTvPage({ continuationCommand: { token: 'x'.repeat(5000) } }).continuation, null);
});

test('browsing without a completed sign-in asks for it, and a revoked refresh token asks to reconnect', async () => {
  const none = fixture();
  await assert.rejects(none.service.home(none.req, none.connections.get('c1')), { status: 409, message: SIGN_IN_REQUIRED });
  const revoked = fixture({ config: { tvRefreshToken: 'rt', tvExpiresAt: 0 }, fetchResponses: [{ status: 400, body: { error: 'invalid_grant' } }] });
  await assert.rejects(revoked.service.home(revoked.req, revoked.connections.get('c1')), error => error.status === 409 && /sign in on this screen again/.test(error.message));
  assert.equal(revoked.created.length, 0);
});

test('stream resolution prefers the signed-in TV client, falls back to anonymous visionOS with page visitor data, defers live videos and gives up on SABR-only data', async () => {
  const statuses = { TV: 'OK', VISIONOS: 'OK' };
  const infoFor = (client) => ({ playability_status: { status: statuses[client], reason: statuses[client] === 'OK' ? '' : 'Sign in to confirm you’re not a bot' }, basic_info: { title: 'Big Buck Bunny', is_live: false }, streaming_data: statuses[client] === 'OK' ? streaming() : undefined });
  const f = fixture({ config: { tvAccessToken: 'at', tvRefreshToken: 'rt', tvExpiresAt: NOW + 3600000 }, info: infoFor });
  const c = f.connections.get('c1');
  const resolved = await f.service.resolve(f.req, c, 'aqz-KE-bpKQ');
  assert.equal(resolved.via, 'innertube-tv');
  assert.equal(resolved.video.url, 'https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&n=ok');
  assert.equal(resolved.audio.url, 'https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&n=ok');
  assert.equal(resolved.isLive, false);
  assert.deepEqual(f.created[0].calls, [['getBasicInfo', 'aqz-KE-bpKQ', 'TV']]);
  statuses.TV = 'LOGIN_REQUIRED';
  const anonymous = await f.service.resolve(f.req, c, 'aqz-KE-bpKQ');
  assert.equal(anonymous.via, 'innertube-visionos');
  assert.equal(f.created.length, 2, 'anonymous client is separate from the signed-in one');
  assert.equal(f.created[1].session.logged_in, false);
  assert.equal(f.created[1].options.visitor_data, 'visitor-1', 'anonymous client carries visitor data from a page view');
  // Connections without InnerTube sign-in skip the TV attempt entirely and reuse the anonymous client.
  const anon = await f.service.resolve(f.req, { id: 'c2', type: 'youtube', config: { apiKey: 'k' } }, 'aqz-KE-bpKQ');
  assert.equal(anon.via, 'innertube-visionos');
  assert.equal(f.created.length, 2);
  // A bot check on stale visitor data mints fresh visitor data once and retries.
  statuses.VISIONOS = 'LOGIN_REQUIRED';
  const seen = [];
  const f2 = fixture({ config: { tvRefreshToken: undefined }, info: (_client, yt) => { seen.push(yt.options.visitor_data); return yt.options.visitor_data === 'visitor-2' ? { playability_status: { status: 'OK' }, basic_info: {}, streaming_data: streaming() } : { playability_status: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' }, basic_info: {} }; } });
  const retried = await f2.service.resolve(f2.req, f2.connections.get('c1'), 'aqz-KE-bpKQ');
  assert.equal(retried.via, 'innertube-visionos');
  assert.deepEqual(seen, ['visitor-1', 'visitor-2']);
  statuses.VISIONOS = 'UNPLAYABLE';
  assert.equal(await f.service.resolve(f.req, c, 'aqz-KE-bpKQ'), null);
  await assert.rejects(f.service.resolve(f.req, c, 'nope'), { status: 400 });
  const live = fixture({ info: () => ({ playability_status: { status: 'OK' }, basic_info: { is_live: true }, streaming_data: streaming() }) });
  assert.deepEqual((await live.service.resolve(live.req, live.connections.get('c1'), 'aqz-KE-bpKQ')).isLive, true);
  const sabr = fixture({ info: () => { const data = streaming(); data.adaptive_formats.forEach(x => { delete x.url; }); return { playability_status: { status: 'OK' }, basic_info: {}, streaming_data: data }; } });
  assert.equal(await sabr.service.resolve(sabr.req, sabr.connections.get('c1'), 'aqz-KE-bpKQ'), null);
  const limited = fixture({ info: () => ({ playability_status: { status: 'OK' }, basic_info: {}, streaming_data: streaming() }), probe: async () => false });
  assert.equal(await limited.service.resolve(limited.req, limited.connections.get('c1'), 'aqz-KE-bpKQ'), null, 'URLs that refuse mid-file ranges are not handed to the player');
  const foreign = fixture({ info: () => ({ playability_status: { status: 'OK' }, basic_info: {}, streaming_data: { adaptive_formats: [ { ...format(137, 'video/mp4; codecs="avc1"', { height: 720 }), decipher: async () => 'https://evil.example/video' }, format(140, 'audio/mp4; codecs="mp4a"') ] } }) });
  assert.equal(await foreign.service.resolve(foreign.req, foreign.connections.get('c1'), 'aqz-KE-bpKQ'), null);
});

async function routesFixture(mode) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'owner' }; next(); });
  const connections = new Map([['c1', { id: 'c1', type: 'youtube', name: 'YouTube', config: { authMode: mode } }]]);
  const service = {
    mode: c => c.config.authMode === 'innertube', signedIn: () => true,
    startSignIn: async () => ({ status: 'pending', userCode: 'CODE' }), signInStatus: async () => ({ status: 'pending' }), cancelSignIn: () => {}, signOut: async () => {},
    home: async (_req, c, token) => ({ items: [{ id: 'aqz-KE-bpKQ', title: token ? 'page 2' : 'page 1', poster: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hq720.jpg' }], nextPageToken: token ? null : 'tok' }),
    search: async (_req, _c, q) => ({ items: [], channels: [{ id: 'UCSMOQeBJ2RAnuFungnQOxLg', title: q, thumbnail: 'https://yt3.ggpht.com/a' }], nextPageToken: null }),
    history: async () => ({ items: [] }), subscriptionsFeed: async () => ({ items: [] }), channels: async () => ({ channels: [] }), playlists: async () => ({ playlists: [] }),
    channelVideos: async () => ({ items: [] }), playlistVideos: async () => ({ items: [] }),
  };
  const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  registerInnertubeRoutes(app, { connection: (_req, id) => { const c = connections.get(id); if (!c) throw Object.assign(new Error('missing'), { status: 404 }); return c; }, route, art: (_req, _c, url) => url ? `/api/media/a_${Buffer.from(url).toString('base64url')}` : undefined, service });
  app.get('/api/youtube/:connectionId/home', (_req, res) => res.status(409).json({ error: 'data api fallthrough' }));
  app.get('/api/youtube/:connectionId/search', (_req, res) => res.json({ dataApi: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { request: (path, init) => fetch(base + path, init), close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

test('routes serve InnerTube connections with proxied artwork and fall through to the Data API handlers otherwise', async t => {
  const inner = await routesFixture('innertube'); t.after(inner.close);
  const home = await (await inner.request('/api/youtube/c1/home')).json();
  assert.equal(home.items[0].title, 'page 1'); assert.ok(home.items[0].poster.startsWith('/api/media/a_')); assert.equal(home.nextPageToken, 'tok');
  assert.equal((await (await inner.request('/api/youtube/c1/home?pageToken=tok')).json()).items[0].title, 'page 2');
  assert.equal((await inner.request('/api/youtube/c1/home?pageToken=not%20valid!')).status, 400);
  const search = await (await inner.request('/api/youtube/c1/search?q=blender')).json();
  assert.equal(search.channels[0].title, 'blender'); assert.ok(search.channels[0].thumbnail.startsWith('/api/media/a_'));
  assert.deepEqual(await (await inner.request('/api/youtube/c1/signin/start', { method: 'POST' })).json(), { status: 'pending', userCode: 'CODE' });
  assert.equal((await inner.request('/api/youtube/c1/feed')).status, 200);
  assert.equal((await inner.request('/api/youtube/missing/home')).status, 404);
  const data = await routesFixture('apiKey'); t.after(data.close);
  assert.equal((await data.request('/api/youtube/c1/home')).status, 409);
  assert.deepEqual(await (await data.request('/api/youtube/c1/search?q=x')).json(), { dataApi: true });
  assert.equal((await data.request('/api/youtube/c1/signin/start', { method: 'POST' })).status, 404);
});
