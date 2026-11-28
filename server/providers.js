import { plainText, mediaDate } from "./text.js";
import { createYouTubeResolver } from "./youtube.js";
import { createInnertubeService, registerInnertubeRoutes, youtubeHeight, YOUTUBE_HEIGHTS } from "./youtube-innertube.js";
import { createSabrBridge } from "./youtube-sabr.js";
import { createProviderCache } from "./provider-cache.js";
import { categoryLoaded } from './iptv-selection.js';
import { validateConnection } from './connection-routes.js';
import { rateLimit } from "express-rate-limit";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  createMediaService,
  remoteData,
  validateRemoteUrl,
  providerError,
} from "./media.js";

const array = (value) =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const numeric = (input) => {
  if (!/^\d{1,20}$/.test(String(input)))
    throw providerError("Invalid media identifier.");
  return String(input);
};
const cleanText = plainText;
const privateHosts = (url) => [
  validateRemoteUrl(url).hostname.replace(/^\[|\]$/g, ""),
];
const pageData = (query) => ({
  page: Math.min(10000, Math.max(1, Number.parseInt(query.page, 10) || 1)),
  limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 60)),
  q: String(query.q || "")
    .trim()
    .slice(0, 200),
  category: String(query.category || ""),
});
/**
 * Whether a probed IPTV movie or episode needs converting for the browser:
 * video other than H.264 (most IPTV films are H.265), or audio WebCodecs and
 * TesPlay's own decoders cannot play (AC-3, E-AC-3, DTS and the like).
 */
export function titleNeedsConversion(probe) {
  if (!probe?.video) return false;
  if (probe.video.codec !== "h264") return true;
  return !!probe.audio && !["aac", "mp3", "mp2", "opus", "flac", "vorbis"].includes(probe.audio.codec);
}

/**
 * How a probed IPTV movie or episode plays: null to play it directly, or the
 * conversion. Car mode (720 or 480) converts any title to that size; otherwise
 * only titles the browser cannot decode are converted, at up to 1080p. Films
 * keep their own frame rate; 50/60 fps sources are halved.
 */
export function planTitleConversion(probe, carHeight = null) {
  if (!probe?.video) return null;
  if (!carHeight && !titleNeedsConversion(probe)) return null;
  return {
    height: carHeight || 1080,
    ...(probe.video.fps > 31 ? { fps: 30 } : {}),
    ...(carHeight ? { carModeHeight: carHeight } : {}),
  };
}

export function paginate(items, query = {}) {
  const { page, limit, q, category } = pageData(query);
  const filtered = items.filter(
    (item) =>
      (!q || item.title.toLowerCase().includes(q.toLowerCase())) &&
      (!category || item.category === category),
  );
  if(query.sort === "recent") filtered.sort((a,b)=>(Date.parse(b.publishedAt || b.addedAt || "")||0)-(Date.parse(a.publishedAt || a.addedAt || "")||0));
  return {
    items: filtered.slice((page - 1) * limit, page * limit),
    hasMore: filtered.length > page * limit,
  };
}

export function parseM3U(text, baseUrl) {
  const entries = [];
  let info = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      const attributes = Object.fromEntries(
        [...line.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
      );
      const comma = line.match(/,(?=(?:[^"\n]*"[^"\n]*")*[^"\n]*$)/);
      info = {
        title: cleanText(
          comma
            ? line.slice(comma.index + 1)
            : attributes["tvg-name"] || "Untitled channel",
        ),
        logo: attributes["tvg-logo"],
        category: attributes["group-title"] || "",
        epgId: attributes["tvg-id"] || "",
      };
    } else if (line && !line.startsWith("#")) {
      try {
        const url = validateRemoteUrl(new URL(line, baseUrl)).toString();
        entries.push({
          ...info,
          title: info?.title || `Channel ${entries.length + 1}`,
          id: createHash("sha256").update(url).digest("hex").slice(0, 32),
          url,
        });
      } catch {
        /* Skip unsupported schemes instead of turning them into proxy requests. */
      }
      info = null;
    }
  }
  return entries;
}

const episodeOrder = (a, b) =>
  (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
  (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0) ||
  a.id.localeCompare(b.id, undefined, { numeric: true });
const episodeNumber = (value, fallback) => {
  const n = Number(value);
  return value !== undefined &&
    value !== null &&
    value !== "" &&
    Number.isSafeInteger(n) &&
    n >= 0
    ? n
    : fallback;
};

export function parseXtreamEpisodes(data, connectionId) {
  const seriesId = numeric(data.series_id || data.info?.series_id || "0");
  const items = Object.entries(data.episodes || {}).flatMap(
    ([season, episodes]) =>
      array(episodes).flatMap((episode, index) => {
        if (!episode || !/^\d{1,20}$/.test(String(episode.id))) return [];
        const seasonNumber = episodeNumber(
          episode.season,
          episodeNumber(season, 0),
        );
        const number = episodeNumber(episode.episode_num, index + 1);
        const extension = /^[a-z0-9]{1,8}$/i.test(
          episode.container_extension || "",
        )
          ? episode.container_extension
          : "mp4";
        return [
          {
            id: `${seriesId}:${numeric(episode.id)}:${extension}`,
            connectionId,
            seriesId,
            seasonNumber,
            episodeNumber: number,
            title: cleanText(episode.title || `Episode ${number}`),
            type: "episode",
            source: "IPTV",
            subtitle: cleanText(data.info?.name),
            description: cleanText(episode.info?.plot),
            duration: Number(episode.info?.duration_secs) || undefined,
            category: `Season ${seasonNumber}`,
            poster: episode.info?.movie_image || data.info?.cover,
          },
        ];
      }),
  );
  return [...new Map(items.map((item) => [item.id, item])).values()].sort(
    episodeOrder,
  );
}

export function registerProviderRoutes(app, ctx, dependencies = {}) {
  const fetchData = dependencies.remoteData || remoteData;
  const media = ctx.media || createMediaService(ctx);
  const resolveYouTube = dependencies.resolveYouTube || createYouTubeResolver();
  const { cached, cacheKey, catalogCached } = createProviderCache(ctx);
  const route = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  const connection = (req, id, type) => {
    const c = ctx.getConnection(req, String(id || ""));
    if (type && c.type !== type)
      throw providerError("Incorrect connection type.");
    return c;
  };
  const permitted = (req,c,value) => categoryLoaded(c,value) && (ctx.canAccess ? ctx.canAccess(req,c,value) : true);
  const ensure = (req,c,value) => { if (!categoryLoaded(c,value)) throw providerError('This category is not loaded. Enable it in IPTV settings.',403); if(ctx.assertAccess) ctx.assertAccess(req,c,value); };
  const saveConfig = (req, c, config) => {
    // A token refresh must not overwrite settings edited during the request.
    const current = ctx.getConnection(req, c.id);
    return ctx.saveConnection(req, {
      id: c.id,
      type: c.type,
      name: current.name,
      config: { ...current.config, ...config },
    }, { allowShared: true });
  };
  // InnerTube (signed-in TV client) browsing and stream resolution; pass innertube: null to disable.
  const innertube = dependencies.innertube === undefined
    ? createInnertubeService({ getConnection: (req, id) => ctx.getConnection(req, id), saveConfig,
      sabr: createSabrBridge({ cacheDir: path.resolve(ctx.dataDir || process.env.DATA_DIR || "data", "youtube-cache") }) })
    : dependencies.innertube;
  const art = (req, c, url, headers = {}) => {
    if (!url) return undefined;
    try {
      const u = validateRemoteUrl(url);
      return media.register(req, c, {
        kind: "artwork",
        url: u.toString(),
        headers:
          c.config.url && new URL(c.config.url).origin === u.origin
            ? headers
            : {},
        allowedPrivateHosts: c.config.url ? privateHosts(c.config.url) : [],
      });
    } catch {
      return undefined;
    }
  };
  const itemBase = (c, data) => ({
    connectionId: c.id,
    source: c.type === "youtube" ? "YouTube" : c.name,
    providerType: c.type,
    ...data,
  });
  async function xtream(c, action, params = {}) {
    const u = validateRemoteUrl(c.config.url);
    u.pathname = u.pathname.replace(
      /\/?(?:player_api\.php)?$/,
      "/player_api.php",
    );
    u.search = new URLSearchParams({
      username: c.config.username || "",
      password: c.config.password || "",
      ...(action ? { action } : {}),
      ...params,
    }).toString();
    const result = await fetchData(u, {
      allowedPrivateHosts: privateHosts(c.config.url),
    });
    if (result?.user_info && String(result.user_info.auth) !== "1")
      throw providerError("The IPTV provider rejected these credentials.");
    return result;
  }
  async function readPlaylist(c) {
    return parseM3U(
      c.config.content || (await fetchData(c.config.url, {
        text: true,
        allowedPrivateHosts: privateHosts(c.config.url),
        maxBytes: 32 * 1024 * 1024,
      })),
      c.config.url || 'https://playlist.invalid/',
    );
  }
  async function playlist(c, force = false) {
    return catalogCached(c, 'playlist', () => readPlaylist(c), force);
  }
  const xtreamActions = { movie: 'get_vod_streams', series: 'get_series', live: 'get_live_streams' };
  // IPTV providers' movies and series are mostly H.265, which the car cannot decode without a
  // transcoder, so only live channels are offered unless IPTV_ON_DEMAND=1 turns them back on.
  const iptvOnDemand = dependencies.iptvOnDemand ?? process.env.IPTV_ON_DEMAND === '1';
  const IPTV_KINDS = iptvOnDemand ? ['live', 'movie', 'series'] : ['live'];
  const iptvOnDemandOff = () => providerError('IPTV movies and series are not available.', 404);
  async function xtreamCatalog(c, kind, force = false) {
    const action = xtreamActions[kind];
    const selected = c.config.loadedCategories;
    if (!Array.isArray(selected)) return array(await catalogCached(c, action, () => xtream(c, action), force));
    const ids = selected.filter(id => id.startsWith(`${kind}:`));
    // Limit simultaneous requests for providers with large category lists.
    const result = [];
    for (let i = 0; i < ids.length; i += 4) {
      const batches = await Promise.all(ids.slice(i, i + 4).map(id =>
        catalogCached(c, `${action}:${id}`, () => xtream(c, action, { category_id: id.split(':')[1] }), force)));
      result.push(...batches.flatMap(array));
    }
    return [...new Map(result.filter(x => selected.includes(`${kind}:${x?.category_id ?? ''}`))
      .map(x => [String(x.series_id ?? x.stream_id), x])).values()];
  }
  async function iptvCategories(c, kinds, force = false, draft = false) {
    const read = (resource, get) => draft ? get() : catalogCached(c, resource, get, force);
    if (c.type === 'm3u') return [...new Set((await (draft ? readPlaylist(c) : playlist(c, force))).map(x => x.category || '__ungrouped__'))]
      .map(id => ({ id, name: id === '__ungrouped__' ? 'Uncategorized' : id, kind: 'live' }));
    return (await Promise.all(kinds.map(async kind => {
      const raw = await read(`categories:${kind}`, () => xtream(c,
        { movie: 'get_vod_categories', series: 'get_series_categories', live: 'get_live_categories' }[kind]));
      return array(raw).filter(x => x?.category_id != null).map(x => ({
        id: `${kind}:${x.category_id}`, name: cleanText(x.category_name), kind,
      }));
    }))).flat();
  }
  // What the transcoder found in each IPTV movie or episode, kept for six hours.
  const titleProbes = new Map();
  async function probeTitle(c, key, url) {
    const cacheKey = `${c.id}:${key}`, hit = titleProbes.get(cacheKey);
    if (hit && Date.now() - hit.at < 6 * 3600000) return hit.value;
    // Without an answer the title plays directly, as it did before conversion existed.
    const value = await media.probeTitle(url).catch(() => null);
    if (value) {
      titleProbes.set(cacheKey, { at: Date.now(), value });
      if (titleProbes.size > 1000) titleProbes.delete(titleProbes.keys().next().value);
    }
    return value;
  }
  async function ensureXtream(req,c,kind,id) {
    if(!c.access && !Array.isArray(c.config.loadedCategories)) { const value={type:kind};ensure(req,c,value);return value; }
    const items=await xtreamCatalog(c,kind);
    const x=array(items).find(x=>String(x.series_id??x.stream_id)===String(id));
    if(!x) throw providerError('This title is not available.',404);
    const value={type:kind,category:`${kind}:${x.category_id??''}`};ensure(req,c,value);return value;
  }
  async function xtreamEpisodes(req, c, seriesId, force = false) {
    const access=await ensureXtream(req,c,"series",seriesId);
    const data = await catalogCached(
      c, `series:${numeric(seriesId)}`,
      () => xtream(c, "get_series_info", { series_id: numeric(seriesId) }), force,
    );
    return parseXtreamEpisodes({ ...data, series_id: seriesId }, c.id).map(
      (item) => ({
        ...item,
        source: c.name,
        providerType: c.type, contentKind:"series", accessCategory:access?.category,
        poster: art(req, c, item.poster),
      }),
    );
  }
  const youtubeSignInLimit = rateLimit({ windowMs: 60000, limit: 6, keyGenerator: (req) => req.user.id, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many Google sign-in attempts. Try again in a minute." } });
  if (innertube) registerInnertubeRoutes(app, { connection, route, art, service: innertube, limiter: youtubeSignInLimit });
  if (!ctx.media) {
    app.get(["/api/media/:token", "/api/v1/media/:token"], media.handler);
    app.delete(["/api/media/:token", "/api/v1/media/:token"], media.releaseHandler);
  }
  async function youtubePlayback(req, videoId, c = null) {
    const controller = new AbortController();
    req.res.once("close", () => { if (!req.res.writableEnded) controller.abort(); });
    // A picture size chosen in the player, straight from YouTube; absent means automatic.
    const height = youtubeHeight(req.query.height);
    // The sizes offered for the player's choice, and the one playing.
    const sizes = (found) => ({
      youtubeQualities: found?.qualities?.length ? found.qualities : YOUTUBE_HEIGHTS.filter((h) => h >= 360).map((h) => ({ height: h, fps: 30, upTo: true })),
      ...(height ? { youtubeHeight: height } : {}),
      ...(found?.picture?.height ? { youtubePicture: found.picture } : {}),
    });
    // InnerTube first (signed-in TV client, then anonymous iOS); yt-dlp remains the fallback and the live path.
    let resolved = innertube ? await innertube.resolve(req, c, videoId, controller.signal, { height }).catch(error => { if (error?.status === 400) throw error; return null; }) : null;
    if (resolved?.live) {
      // A live broadcast relayed segment by segment: two growing fragmented-MP4 tracks.
      const track = (name) => media.register(req, c, { kind: "video", live: { session: resolved.live, track: name }, contentType: name === "audio" ? "audio/mp4" : "video/mp4" });
      return { url: track("video"), audioUrl: track("audio"), type: "video", isLive: true, streamKind: "growing-fmp4", provider: "youtube", via: resolved.via, ...sizes(resolved) };
    }
    // yt-dlp cannot list the sizes cheaply; it plays the tallest at or below the chosen one.
    if (!resolved?.video) resolved = await resolveYouTube(videoId, controller.signal, { height });
    const register = (resource, prefetchBytes) => media.register(req, c, resource.spool
      // A SABR track spooled on the server: served by byte range as it downloads.
      ? { kind: "video", spool: resource.spool, contentType: "video/mp4", touch: () => resolved.sabr?.touch?.() }
      : {
        url: resource.url, headers: resource.headers, kind: resource.hls ? "hls" : "video",
        // googlevideo refuses open-ended and multi-megabyte ranges; the proxy re-chunks them.
        // The opening bytes are fetched right away, while this answer travels to the player.
        ...(resolved.via && !resource.hls ? { chunkBytes: 4 * 1024 * 1024, prefetchBytes, onRefused: () => innertube?.forget?.(c, videoId) } : {}),
      });
    return {
      url: register(resolved.video, 2 * 1024 * 1024),
      ...(resolved.audio ? { audioUrl: register(resolved.audio, 512 * 1024) } : {}),
      type: resolved.video.hls ? "hls" : "video",
      isLive: resolved.isLive,
      streamKind: resolved.audio ? "dual-input" : "direct-file",
      provider: "youtube",
      ...(resolved.via ? { via: resolved.via } : {}),
      ...sizes(resolved.via ? resolved : null),
    };
  }
  const youtubeLimit = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: (req) => req.user.id, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many YouTube requests. Try again in a minute." } });
  app.get("/api/youtube/resolve/:videoId", youtubeLimit, route(async (req, res) => {
    res.json(await youtubePlayback(req, req.params.videoId));
  }));

  app.post(
    "/api/connections/:id/test",
    route(async (req, res) => {
      const c = connection(req, req.params.id);
      if (c.type === "xtream") {
        const data = await xtream(c);
        if (!data.user_info)
          throw providerError(
            "This does not appear to be an Xtream Codes endpoint.",
          );
      } else if (c.type === "m3u") {
        if (!(await playlist(c)).length)
          throw providerError(
            "The playlist contains no supported HTTP streams.",
          );
      } else if (c.type === "youtube") {
        if (!innertube) throw providerError("YouTube is unavailable on this server.", 503);
        await innertube.test(req, c);
      } else throw providerError("Unsupported connection type.");
      res.json({ ok: true, message: `${c.name} is connected.` });
    }),
  );

  app.post('/api/connections/categories/preview', route(async (req, res) => {
    const c = validateConnection(req.body);
    if (!['xtream', 'm3u'].includes(c.type)) throw providerError('Choose an IPTV connection.', 400);
    const config = c.config;
    if (c.type === 'xtream' && ['url', 'username', 'password'].some(key => typeof config[key] !== 'string' || !config[key].trim()))
      throw providerError('Enter the provider URL, username and password first.', 400);
    if (c.type === 'm3u' && ![config.url, config.content].some(value => typeof value === 'string' && value.trim()))
      throw providerError('Enter a playlist URL or paste a playlist first.', 400);
    // Unsaved credentials and playlist data stay in this request, outside catalog persistence.
    try {
      res.json({ categories: await iptvCategories(c, IPTV_KINDS, false, true) });
    } catch (error) {
      // A reverse proxy replaces gateway responses with its own page, hiding the
      // provider's explanation. A failed draft is a setup error, not a TesPlay outage.
      if ([502, 503, 504].includes(error.status))
        throw Object.assign(providerError(`Could not load IPTV categories. ${error.message}`, 422), { code: 'IPTV_PROVIDER_UNAVAILABLE' });
      throw error;
    }
  }));

  app.get(
    '/api/connections/:id/categories',
    route(async (req, res) => {
      const c = connection(req, req.params.id);
      if (!['xtream', 'm3u'].includes(c.type)) throw providerError('Choose an IPTV connection.', 400);
      res.json({ categories: await iptvCategories(c, IPTV_KINDS, req.query.refresh === '1'),
        loadedCategories: c.config.loadedCategories ?? null });
    }),
  );

  app.get(
    "/api/catalog",
    route(async (req, res) => {
      const c = connection(req, req.query.connectionId);
      const p = pageData(req.query);
      const kind = String(req.query.kind || "all");
      const parent = String(req.query.parentId || "");
      const force = req.query.refresh === "1";
      if (c.type === "xtream") {
        if ((parent && !iptvOnDemand) || (kind !== "all" && !IPTV_KINDS.includes(kind)))
          return res.json({ ...paginate([], req.query), categories: [] });
        if (parent) {
          const items = await xtreamEpisodes(req, c, parent, force);
          return res.json({
            ...paginate(items, req.query),
            categories: [...new Set(items.map((item) => item.category))].map(
              (name) => ({ id: name, name }),
            ),
          });
        }
        const kinds = kind === "all" ? ["movie", "series", "live"].filter(k => IPTV_KINDS.includes(k)).filter(k=>!c.access || c.access.kinds.includes(k)) : [kind];
        if(kind!=="all" && c.access && !c.access.kinds.includes(kind)) throw providerError("This content type is not shared with your account.",403);
        if (kinds.some((k) => !["movie", "series", "live"].includes(k)))
          throw providerError("Unsupported IPTV catalog.");
        const batches = await Promise.all(
          kinds.map(async (k) => {
            const raw = await xtreamCatalog(c, k, force);
            return array(raw)
              .filter((x) => x && (x.stream_id != null || x.series_id != null) && permitted(req,c,{type:k,category:`${k}:${x.category_id??""}`}))
              .map((x) =>
                itemBase(c, {
                  id: String(x.series_id || x.stream_id),
                  title: cleanText(x.name),
                  addedAt: mediaDate(x.added || x.last_modified),
                  type: k,
                  poster: x.stream_icon || x.cover,
                  description: cleanText(x.plot),
                  year: String(x.year || x.releaseDate?.slice(0, 4) || ""),
                  category: `${k}:${String(x.category_id ?? "")}`,
                }),
              );
          }),
        );
        const category =
          p.category && !p.category.includes(":") && kinds.length === 1
            ? `${kinds[0]}:${p.category}`
            : p.category;
        const catalogItems = batches.flat().filter(item => !category || item.category === category);
        // Home previews should show the most recent titles whose provider supplied
        // valid artwork. Keep the complete catalog and an empty-artwork fallback.
        const withArtwork = req.query.artwork === 'prefer' && kinds.every(k => k !== 'live')
          ? catalogItems.filter(item => {
              if (!item.poster) return false;
              try { validateRemoteUrl(item.poster); return true; } catch { return false; }
            }) : [];
        const paged = paginate(withArtwork.length ? withArtwork : catalogItems, { ...req.query, category });
        paged.items = paged.items.map((item) => ({
          ...item,
          poster: art(req, c, item.poster),
        }));
        const categories = (
          await Promise.all(
            kinds.map(async (k) => {
              const raw = await catalogCached(c, `categories:${k}`, () =>
                xtream(
                  c,
                  {
                    movie: "get_vod_categories",
                    series: "get_series_categories",
                    live: "get_live_categories",
                  }[k],
                ), force,
              ).catch(() => []);
              return array(raw)
                .filter((x) => x?.category_id != null)
                .map((x) => ({
                  id: `${k}:${String(x.category_id)}`,
                  label: cleanText(x.category_name),
                  name: `${kinds.length > 1 ? { movie: "Movies · ", series: "Series · ", live: "Live TV · " }[k] : ""}${cleanText(x.category_name)}`,
                }));
            }),
          )
        ).flat();
        const categoryLabels = new Map(
          categories.map((entry) => [entry.id, entry.label]),
        );
        paged.items = paged.items.map((item) => ({
          ...item,
          categoryLabel:
            categoryLabels.get(item.category) ||
            { movie: "Movies", series: "Series", live: "Live TV" }[item.type],
        }));
        return res.json({
          ...paged,
          categories: [
            ...new Map(
              categories.filter(x=>(!Array.isArray(c.config.loadedCategories) || c.config.loadedCategories.includes(x.id)) && (!c.access?.categories || c.access.categories.includes(x.id))).map(({ id, name }) => [id, { id, name }]),
            ).values(),
          ],
        });
      }
      if (c.type === "m3u") {
        const entries = (await playlist(c, force)).filter(x=>permitted(req,c,{type:"live",category:x.category || '__ungrouped__'}));
        const paged = paginate(
          entries.map((x) =>
            itemBase(c, {
              id: x.id,
              title: x.title,
              category: x.category || '__ungrouped__',
              type: "live",
              poster: x.logo,
            }),
          ),
          req.query,
        );
        paged.items = paged.items.map((x) => ({
          ...x,
          poster: art(req, c, x.poster),
        }));
        return res.json({
          ...paged,
          categories: [
            ...new Set(entries.map((x) => x.category || '__ungrouped__')),
          ].map((x) => ({ id: x, name: x === '__ungrouped__' ? 'Uncategorized' : x })),
        });
      }
      throw providerError("Unsupported library.");
    }),
  );

  async function seriesEpisodes(req, c, id, kind) {
    if (c.type === "xtream") {
      if (!IPTV_KINDS.includes('series')) return [];
      const seriesId = kind === 'series' ? numeric(id) : /^(\d+):\d+:[a-zA-Z0-9]{1,8}$/.exec(id)?.[1];
      if (!seriesId) throw providerError("Invalid series or episode.");
      return xtreamEpisodes(req, c, seriesId);
    }
    return [];
  }
  app.get(['/api/episodes', '/api/episodes/next'], route(async (req, res) => {
    const c = connection(req, req.query.connectionId), id = String(req.query.itemId || '');
    const items = await seriesEpisodes(req, c, id, String(req.query.kind || 'episode'));
    const index = items.findIndex(item => item.id === id || c.type === 'xtream' && item.id.split(':').slice(0,2).join(':') === id.split(':').slice(0,2).join(':'));
    if (req.path.endsWith('/next')) {
      if (items.length && index < 0) throw providerError("Episode is no longer available in this series.", 404);
      return res.json({item: items[index + 1] || null});
    }
    res.json({items, next: index >= 0 ? items[index + 1] || null : null, previous: index > 0 ? items[index - 1] : null});
  }));

  app.get('/api/playback/options', route(async (req,res) => {
    const c = connection(req, req.query.connectionId), id = String(req.query.itemId || '');
    if (c.type === 'xtream') await ensureXtream(req,c,req.query.kind === 'episode' ? 'series' : String(req.query.kind), req.query.kind === 'episode' ? id.split(':')[0] : id);
    return res.json({audio:[],subtitles:[],qualities:[]});
  }));

  app.get(
    "/api/playback",
    route(async (req, res) => {
      const c = connection(req, req.query.connectionId);
      const id = String(req.query.itemId || "");
      const kind = String(req.query.kind || "movie");
      // Server audio conversion (AC-3 to AAC) and car mode (a 720p30 stream
      // from the transcoder) need a continuous MPEG-TS source and are offered
      // for live channels only. Car mode without a configured transcoder plays
      // the channel normally, so a device setting can never break playback.
      const requested = req.query.compatibility === undefined ? null : String(req.query.compatibility);
      if (requested !== null && !["audio", "video"].includes(requested)) throw providerError("Choose a valid compatibility option.");
      if (requested === "audio" && kind !== "live") throw providerError("Audio conversion is available for live channels only.");
      let compatibility = requested === "video" && (kind !== "live" || !media.carModeAvailable) ? null : requested;
      // Car mode is offered for live channels and, on Xtream, for movies and episodes.
      const carMode = media.carModeAvailable && (kind === "live" || c.type === "xtream") ? { carMode: true } : {};
      // Car mode sizes the player offers; 720p unless 480p is asked for.
      const carHeight = req.query.carHeight === "480" ? 480 : 720;
      // A movie or episode in car mode is converted to that size even when it is H.264.
      const titleCarHeight = requested === "video" && kind !== "live" && media.carModeAvailable ? carHeight : null;
      const conversion = () => compatibility === "video" ? { remux: "video", transcodeHeight: carHeight } : compatibility ? { remux: compatibility } : {};
      const converted = () => compatibility ? { compatibility, isLive: true, ...(compatibility === "video" ? { carModeHeight: carHeight } : {}) } : {};
      if (c.type === "xtream") {
        if (!IPTV_KINDS.includes(kind === "episode" ? "series" : kind)) throw iptvOnDemandOff();
        let category, extension, streamId, listedDuration = 0;
        if (kind === "live") {
          await ensureXtream(req,c,"live",id);
          category = "live";
          streamId = numeric(id);
          extension = c.config.output === "ts" || compatibility ? "ts" : "m3u8";
        } else if (kind === "episode") {
          const match = /^(\d+):(\d+):([a-zA-Z0-9]{1,8})$/.exec(id);
          if (!match) throw providerError("Invalid episode.");
          await ensureXtream(req,c,"series",match[1]);
          const data = await xtream(c, "get_series_info", {
            series_id: match[1],
          });
          const episode = Object.values(data.episodes || {})
            .flatMap(array)
            .find((x) => String(x.id) === match[2]);
          if (!episode) throw providerError("Episode not found.", 404);
          category = "series";
          streamId = match[2];
          extension = String(episode.container_extension || "mp4");
          listedDuration = Number(episode.info?.duration_secs) || 0;
        } else if (kind === "movie") {
          await ensureXtream(req,c,"movie",id);
          const data = await xtream(c, "get_vod_info", { vod_id: numeric(id) });
          if (!data.movie_data) throw providerError("Movie not found.", 404);
          category = "movie";
          streamId = numeric(id);
          extension = String(data.movie_data.container_extension || "mp4");
          listedDuration = Number(data.info?.duration_secs) || 0;
        } else throw providerError("Select an episode before playing.");
        if (!/^[a-zA-Z0-9]{1,8}$/.test(extension))
          throw providerError("Invalid stream format.");
        const u = validateRemoteUrl(c.config.url);
        u.pathname =
          u.pathname.replace(/\/?(?:player_api\.php)?$/, "/") +
          `${category}/${encodeURIComponent(c.config.username)}/${encodeURIComponent(c.config.password)}/${streamId}.${extension}`;
        u.search = "";
        // IPTV movies and episodes the browser cannot decode (most are H.265)
        // are converted to H.264 by the transcoder, from the requested position.
        if (kind !== "live" && media.carModeAvailable) {
          const probe = await probeTitle(c, `${kind}:${streamId}`, u.toString());
          const plan = planTitleConversion(probe, titleCarHeight);
          if (plan) {
            const durationSeconds = probe.durationSeconds || (listedDuration > 0 ? Math.round(listedDuration) : null);
            const requested = Math.max(0, Math.floor(Number(req.query.start) || 0));
            const start = durationSeconds ? Math.min(requested, Math.max(0, durationSeconds - 5)) : requested;
            return res.json({
              url: media.register(req, c, {
                url: u.toString(), allowedPrivateHosts: privateHosts(c.config.url), kind: "video",
                remux: "vod", transcodeStart: start, transcodeHeight: plan.height,
                ...(plan.fps ? { transcodeFps: plan.fps } : {}),
              }),
              type: "video", streamKind: "continuous-ts", compatibility: "vod",
              durationSeconds, startSeconds: start, ...carMode,
              ...(plan.carModeHeight ? { carModeHeight: plan.carModeHeight } : {}),
            });
          }
        }
        const type = extension === "m3u8" ? "hls" : "video";
        return res.json({
          url: media.register(req, c, {
            url: u.toString(),
            allowedPrivateHosts: privateHosts(c.config.url),
            kind: type,
            ...conversion(),
          }),
          type,
          streamKind: extension === "ts" ? "continuous-ts" : "direct-file",
          ...converted(),
          ...carMode,
        });
      }
      if (c.type === "m3u") {
        const entry = (await playlist(c)).find((x) => x.id === id);
        if (!entry) throw providerError("Channel not found.", 404);
        ensure(req,c,{type:"live",category:entry.category || '__ungrouped__'});
        const playlistEntry = /\.m3u8(?:\?|$)/i.test(entry.url);
        if (compatibility === "audio" && playlistEntry)
          throw providerError("Audio conversion needs a continuous stream; this channel is an HLS playlist.");
        // The transcoder reads continuous MPEG-TS, so HLS entries play normally.
        if (compatibility === "video" && playlistEntry) compatibility = null;
        const type = playlistEntry && !compatibility ? "hls" : "video";
        return res.json({
          url: media.register(req, c, {
            url: entry.url,
            allowedPrivateHosts: c.config.url ? privateHosts(c.config.url) : [],
            ...conversion(),
          }),
          type,
          streamKind: compatibility || /\.ts(?:\?|$)/i.test(entry.url) ? "continuous-ts" : "direct-file",
          ...converted(),
          ...(playlistEntry ? {} : carMode),
        });
      }
      if (c.type === "youtube") {
        if (!/^[a-zA-Z0-9_-]{11}$/.test(id))
          throw providerError("Invalid YouTube video.");
        ensure(req,c,{type:"video"});
        return res.json(await youtubePlayback(req, id, c));
      }
      throw providerError("Unsupported playback source.");
    }),
  );

  app.get(
    "/api/epg",
    route(async (req, res) => {
      const c = connection(req, req.query.connectionId, "xtream");
      await ensureXtream(req,c,"live",req.query.itemId);
      const data = await xtream(c, "get_short_epg", {
        stream_id: numeric(req.query.itemId),
        limit: "30",
      });
      const decodeText = (s) => {
        try {
          return cleanText(
            Buffer.from(String(s || ""), "base64").toString("utf8"),
          );
        } catch {
          return cleanText(s);
        }
      };
      res.json({
        programs: array(data.epg_listings).map((x) => ({
          title: decodeText(x.title),
          description: decodeText(x.description),
          start: x.start_timestamp
            ? new Date(Number(x.start_timestamp) * 1000).toISOString()
            : x.start,
          end: x.stop_timestamp
            ? new Date(Number(x.stop_timestamp) * 1000).toISOString()
            : x.end,
        })),
      });
    }),
  );

}
