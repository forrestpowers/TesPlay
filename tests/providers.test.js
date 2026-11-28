import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto, { randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import express from "express";
import {
  registerProviderRoutes,
  parseM3U,
  paginate,
  parseXtreamEpisodes,
} from "../server/providers.js";
import {
  addressClass,
  validateRemoteUrl,
  requestRemote,
  remoteData,
  parseRange,
  rewriteHls,
  subtitleToVtt,
} from "../server/media.js";
import { encryptJSON, decryptJSON } from "../server/security.js";

const lan = Object.values(os.networkInterfaces())
  .flat()
  .find(
    (x) =>
      x.family === "IPv4" &&
      !x.internal &&
      addressClass(x.address) === "private",
  )?.address;
async function listen(app, host = "127.0.0.1") {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return {
    server,
    url: `http://${host === "0.0.0.0" ? lan : host}:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
async function fixture(t, options = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aperture-provider-"));
  const app = express();
  app.use(express.json());
  const connections = options.connections || new Map();
  let counter = connections.size;
  const key = options.key || randomBytes(32);
  app.use((req, res, next) => {
    if (req.headers.authorization !== "fixture")
      return res.status(401).json({ error: "Sign in" });
    req.user = { id: "owner" };
    req.session = { id: req.headers["x-session"] || "session" };
    req.profile = req.headers["x-profile"] || "p1";
    next();
  });
  const ctx = {
    sealMedia: (value) =>
      Buffer.from(
        encryptJSON(value, key, "media-resource:v1"),
        "base64",
      ).toString("base64url"),
    openMedia: (token) =>
      decryptJSON(
        Buffer.from(token, "base64url").toString("base64"),
        key,
        "media-resource:v1",
      ),
    stars: () => options.stars || [],
    getProfileId: (req) => req.profile,
    getConnection: (_req, id) => {
      const c = connections.get(id);
      if (!c) throw Object.assign(new Error("Not found"), { status: 404 });
      return c;
    },
    saveConnection: (_req, c) => {
      const id = c.id || String(++counter);
      const previous = connections.get(id);
      const saved = {
        ...previous,
        ...c,
        id,
        config: { ...previous?.config, ...c.config },
      };
      connections.set(id, saved);
      return { id, type: saved.type, name: saved.name };
    },
  };
  // InnerTube is disabled unless a test injects a fake, so no test reaches YouTube.
  registerProviderRoutes(app, ctx, { remoteData: options.remoteData, resolveYouTube: options.resolveYouTube, innertube: options.innertube ?? null, iptvOnDemand: options.iptvOnDemand ?? true });
  app.use((err, _req, res, _next) =>
    res.status(err.status || 500).json({ error: err.message }),
  );
  const server = await listen(app);
  t.after(async () => {
    await server.close();
    await rm(temp, { recursive: true, force: true });
  });
  return {
    ...server,
    temp,
    connections,
    key,
    add: (type, config) => {
      const id = String(++counter);
      connections.set(id, { id, type, name: type, config });
      return id;
    },
    request: (url, options = {}) =>
      fetch(server.url + url, {
        ...options,
        headers: { Authorization: "fixture", ...options.headers },
      }),
  };
}

test("URL policy rejects loopback, cloud metadata, mapped IPv6, credentials and unsupported protocols", async () => {
  for (const url of [
    "http://127.0.0.1",
    "http://2130706433",
    "http://[::1]",
    "http://[::ffff:7f00:1]",
    "http://169.254.169.254/latest",
    "http://100.100.100.200",
    "http://168.63.129.16",
    "http://metadata.google.internal",
    "http://localhost",
    "file:///etc/passwd",
    "http://user:pass@example.com",
  ])
    assert.throws(() => validateRemoteUrl(url), url);
  assert.equal(addressClass("10.4.0.2"), "private");
  assert.equal(addressClass("192.168.1.8"), "private");
  assert.equal(addressClass("8.8.8.8"), "public");
  assert.equal(addressClass("0:0:0:0:0:0:0:1"), "blocked");
  assert.equal(addressClass("::ffff:169.254.169.254"), "blocked");
  await assert.rejects(() => requestRemote("http://169.254.169.254/latest"));
});

test('OAuth token failures classify only known codes and keep provider details private', async t => {
  assert.ok(lan, 'A local private interface is required for the provider fixture');
  const app = express();
  app.get('/:code', (req, res) => res.status(400).json({
    error: req.params.code, error_description: 'client_secret=private-refresh-token',
  }));
  app.get('/malformed/body', (_req, res) => res.status(400).send('<html>private-refresh-token</html>'));
  app.get('/oversized/body', (_req, res) => res.status(400).send('private-refresh-token'.repeat(2000)));
  const server = await listen(app, '0.0.0.0');
  t.after(() => server.close());
  for (const code of ['invalid_grant', 'invalid_client', 'unknown_secret', 'malformed/body', 'oversized/body']) {
    await assert.rejects(remoteData(server.url + '/' + code, { allowedPrivateHosts: [lan], oauthToken: true }), error => {
      assert.equal(error.status, 502);
      assert.equal(error.oauthCode, ['invalid_grant', 'invalid_client'].includes(code) ? code : undefined);
      assert.ok(!JSON.stringify(error).includes('secret'));
      assert.ok(!error.message.includes('private-refresh-token'));
      return true;
    });
  }
  await assert.rejects(remoteData(server.url + '/invalid_grant', { allowedPrivateHosts: [lan] }), error => error.oauthCode === undefined);
});

test("M3U parses quoted attributes, grouped channels, relative URLs and excludes unsafe schemes", () => {
  const list = parseM3U(
    '#EXTM3U\n#EXTINF:-1 tvg-logo="https://cdn.example/a,b.jpg" group-title="News, World",World News\nchannel.m3u8?secret=abc\n#EXTINF:-1,Unsupported\nfile:///etc/passwd\n#EXTINF:-1,Music\nhttps://radio.example/live\n',
    "https://iptv.example/list.m3u",
  );
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "World News");
  assert.equal(list[0].category, "News, World");
  assert.equal(list[0].url, "https://iptv.example/channel.m3u8?secret=abc");
  assert.match(list[0].id, /^[a-f0-9]{32}$/);
  assert.equal(list[0].logo, "https://cdn.example/a,b.jpg");
});

test("catalog pagination caps 100 and searches before slicing; episodes retain series and season", () => {
  const items = Array.from({ length: 250 }, (_, i) => ({
    title: `Title ${i}`,
    category: i % 2 ? "A" : "B",
  }));
  assert.equal(paginate(items, { limit: 200 }).items.length, 100);
  assert.equal(paginate(items, { limit: 100, page: 3 }).items.length, 50);
  assert.equal(paginate(items, { q: "249" }).items[0].title, "Title 249");
  const episodes = parseXtreamEpisodes(
    {
      series_id: 8,
      episodes: {
        2: [{ id: 51, title: "Episode", container_extension: "mp4" }],
      },
    },
    "c1",
  );
  assert.equal(episodes[0].id, "8:51:mp4");
  assert.equal(episodes[0].category, "Season 2");
});

test("HLS rewrites nested manifests, segments, audio renditions and encrypted-stream key URIs", () => {
  const urls = [];
  const result = rewriteHls(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?token=secret"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"\n../variant.m3u8\nsegment.ts\n',
    "https://media.example/parent/master.m3u8",
    (url) => {
      urls.push(url);
      return `/api/media/${urls.length}`;
    },
  );
  assert.equal(urls[0], "https://media.example/parent/key.bin?token=secret");
  assert.equal(urls[2], "https://media.example/variant.m3u8");
  assert.equal(urls.length, 4);
  assert.ok(!result.includes("secret"));
  assert.ok(!result.includes("media.example"));
  assert.match(result, /URI="\/api\/media\/1"/);
});

test("byte ranges handle suffixes and malformed/multiple ranges; SRT timestamps become browser captions", () => {
  assert.deepEqual(parseRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=7-", 10), { start: 7, end: 9 });
  for (const range of [
    "bytes=9-1",
    "bytes=10-",
    "bytes=0-1,4-5",
    "bytes=-0",
    "bytes=-",
  ])
    assert.equal(parseRange(range, 10), false);
  assert.equal(
    subtitleToVtt("1\n00:00:00,000 --> 00:00:01,500\nHello"),
    "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nHello",
  );
});

test(
  "Xtream fixtures exercise categories, search, episodes, EPG and secret-free nested HLS playback",
  { skip: !lan },
  async (t) => {
    const originalRandomBytes = crypto.randomBytes;
    let mediaTokens = 0;
    let forcedCollision = false;
    const randomBytesMock = t.mock.method(crypto, "randomBytes", function (size, ...args) {
      const bytes = originalRandomBytes.call(this, size, ...args);
      if (size === 24 && Buffer.isBuffer(bytes) && ++mediaTokens === 4) {
        // The nested segment's random value begins with the artwork prefix a_.
        bytes[0] = 0x6b;
        bytes[1] |= 0xf0;
        forcedCollision = true;
      }
      return bytes;
    });
    syncBuiltinESMExports();
    t.after(() => {
      randomBytesMock.mock.restore();
      syncBuiltinESMExports();
    });
    const upstream = await listen((req, res) => {
      const u = new URL(req.url, "http://fixture");
      res.setHeader("Content-Type", "application/json");
      if (u.pathname === "/player_api.php") {
        assert.equal(u.searchParams.get("username"), "user");
        assert.equal(u.searchParams.get("password"), "provider-secret");
        const action = u.searchParams.get("action");
        const data = {
          get_vod_streams: [{ stream_id: 41, name: "Orbit", category_id: 2 }],
          get_series: [{ series_id: 8, name: "Seasonal" }],
          get_live_streams: [{ stream_id: 7, name: "News", category_id: 3 }],
          get_vod_categories: [{ category_id: 2, category_name: "Cinema" }],
          get_series_categories: [],
          get_live_categories: [{ category_id: 3, category_name: "World" }],
          get_vod_info: { movie_data: { container_extension: "mp4" } },
          get_series_info: {
            episodes: {
              1: [{ id: 91, title: "Pilot", container_extension: "mp4" }],
            },
          },
          get_short_epg: {
            epg_listings: [
              {
                title: Buffer.from("World Tonight").toString("base64"),
                description: Buffer.from("Headlines").toString("base64"),
                start_timestamp: "1700000000",
                stop_timestamp: "1700003600",
              },
            ],
          },
        }[action] || { user_info: { auth: 1 } };
        return res.end(JSON.stringify(data));
      }
      if (u.pathname.includes("/live/")) {
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        return res.end(
          "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\n/cdn/variant.m3u8?key=provider-secret\n",
        );
      }
      if (u.pathname === "/cdn/variant.m3u8") {
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        return res.end(
          '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?secret=provider-secret"\n#EXTINF:4,\nsegment.ts\n',
        );
      }
      res.setHeader("Content-Type", "video/mp2t");
      res.end("segment-body");
    }, "0.0.0.0");
    t.after(upstream.close);
    const f = await fixture(t);
    const id = f.add("xtream", {
      url: upstream.url,
      username: "user",
      password: "provider-secret",
    });
    assert.equal(
      (await f.request(`/api/connections/${id}/test`, { method: "POST" }))
        .status,
      200,
    );
    const catalog = await (
      await f.request(`/api/catalog?connectionId=${id}&kind=all&q=Orbit`)
    ).json();
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.categories[0].name, "Movies · Cinema");
    const episodes = await (
      await f.request(`/api/catalog?connectionId=${id}&parentId=8`)
    ).json();
    assert.equal(episodes.items[0].id, "8:91:mp4");
    const epg = await (
      await f.request(`/api/epg?connectionId=${id}&itemId=7`)
    ).json();
    assert.equal(epg.programs[0].title, "World Tonight");
    const playback = await (
      await f.request(`/api/playback?connectionId=${id}&itemId=7&kind=live`)
    ).json();
    assert.equal(playback.type, "hls");
    assert.ok(!JSON.stringify(playback).includes("provider-secret"));
    // Server audio conversion switches the live channel to the provider's continuous stream.
    const converted = await (
      await f.request(`/api/playback?connectionId=${id}&itemId=7&kind=live&compatibility=audio`)
    ).json();
    assert.equal(converted.type, "video");
    assert.equal(converted.streamKind, "continuous-ts");
    assert.equal(converted.compatibility, "audio");
    assert.equal(converted.isLive, true);
    assert.ok(!JSON.stringify(converted).includes("provider-secret"));
    // Car mode without a configured transcoder plays the channel normally.
    const unconverted = await (
      await f.request(`/api/playback?connectionId=${id}&itemId=7&kind=live&compatibility=video`)
    ).json();
    assert.equal(unconverted.type, "hls");
    assert.equal(unconverted.compatibility, undefined);
    assert.equal(unconverted.carMode, undefined);
    assert.equal((await f.request(`/api/playback?connectionId=${id}&itemId=7&kind=live&compatibility=other`)).status, 400);
    assert.equal((await f.request(`/api/playback?connectionId=${id}&itemId=41&kind=movie&compatibility=audio`)).status, 400);
    const master = await (await f.request(playback.url)).text();
    assert.equal(await (await f.request(playback.url)).text(), master);
    assert.ok(!master.includes("provider-secret"));
    const variantPath = master.split("\n").find((x) => x.startsWith("/api/"));
    const variant = await (await f.request(variantPath)).text();
    assert.equal(await (await f.request(variantPath)).text(), variant);
    assert.ok(!variant.includes("provider-secret"));
    assert.match(variant, /URI="\/api\/media\//);
    const segmentPath = variant.split("\n").find((x) => x.startsWith("/api/"));
    assert.equal(await (await f.request(segmentPath)).text(), "segment-body");
    assert.equal(forcedCollision, true, "the test must exercise the reserved-prefix collision");
  },
);

test(
  "remote requests reject private hosts without explicit configuration and revalidate redirect targets",
  { skip: !lan },
  async (t) => {
    const upstream = await listen((_req, res) => {
      res.writeHead(302, {
        Location: "http://169.254.169.254/latest/meta-data",
      });
      res.end();
    }, "0.0.0.0");
    t.after(upstream.close);
    await assert.rejects(
      () => requestRemote(upstream.url),
      /restricted network/,
    );
    await assert.rejects(
      () => requestRemote(upstream.url, { allowedPrivateHosts: [lan] }),
      /not allowed/,
    );
  },
);

test("YouTube searches stay server-side", async (t) => {
  const f = await fixture(t, {
    resolveYouTube: async (id) => {
      assert.equal(id, 'abcdefghijk');
      return { video: { url: 'https://test.googlevideo.com/video?token=private', headers: {} }, audio: { url: 'https://test.googlevideo.com/audio?token=private', headers: {} }, isLive: false };
    },
    remoteData: async (input) => {
      const u = new URL(input);
      if (u.hostname === "www.googleapis.com") {
        assert.equal(u.searchParams.get("key"), "youtube-api-secret");
        assert.equal(u.searchParams.get("videoEmbeddable"), "true");
        return {
          items: [
            {
              id: { videoId: "abcdefghijk" },
              snippet: {
                title: "Film",
                description: "Description",
                thumbnails: {},
              },
            },
          ],
          nextPageToken: "yt-next",
        };
      }
      throw new Error(`unexpected request ${u.hostname}`);
    },
  });
  const id = f.add("youtube", { apiKey: "youtube-api-secret" });
  const list = await (
    await f.request(`/api/catalog?connectionId=${id}&q=film`)
  ).json();
  assert.equal(list.nextPageToken, "yt-next");
  assert.ok(!JSON.stringify(list).includes("secret"));
  const video = await (
    await f.request(`/api/playback?connectionId=${id}&itemId=abcdefghijk`)
  ).json();
  assert.equal(video.type, "video");
  assert.equal(video.streamKind, "dual-input");
  assert.match(video.url, /^\/api\/media\//);
  assert.match(video.audioUrl, /^\/api\/media\//);
  assert.ok(!JSON.stringify(video).includes('private'));
});

test("IPTV offers live channels only unless on-demand titles are switched on", async (t) => {
  const calls = [];
  const f = await fixture(t, {
    iptvOnDemand: false,
    remoteData: async (input) => {
      const action = new URL(input).searchParams.get("action");
      calls.push(action);
      return {
        get_live_streams: [{ stream_id: 1, name: "Channel", category_id: 4 }],
        get_vod_streams: [{ stream_id: 2, name: "Movie", category_id: 4 }],
        get_series: [{ series_id: 8, name: "Show", category_id: 4 }],
        get_live_categories: [{ category_id: 4, category_name: "News" }],
        get_vod_categories: [{ category_id: 4, category_name: "Films" }],
        get_series_categories: [{ category_id: 4, category_name: "Drama" }],
      }[action];
    },
  });
  const id = f.add("xtream", { url: "https://iptv.example", username: "user", password: "secret" });
  const all = await (await f.request(`/api/catalog?connectionId=${id}`)).json();
  assert.deepEqual(all.items.map((item) => item.title), ["Channel"]);
  assert.deepEqual(all.categories.map((x) => x.id), ["live:4"]);
  const categories = await (await f.request(`/api/connections/${id}/categories`)).json();
  assert.deepEqual(categories.categories.map((x) => x.id), ["live:4"]);
  for (const kind of ["movie", "series"])
    assert.deepEqual((await (await f.request(`/api/catalog?connectionId=${id}&kind=${kind}`)).json()).items, []);
  assert.deepEqual((await (await f.request(`/api/catalog?connectionId=${id}&parentId=8`)).json()).items, []);
  const movie = await f.request(`/api/playback?connectionId=${id}&itemId=2&kind=movie`);
  assert.equal(movie.status, 404);
  assert.match((await movie.json()).error, /movies and series are not available/);
  assert.ok(!calls.some((action) => /vod|series/.test(action)), "on-demand lists are never fetched from the provider");
});

test("Xtream category IDs stay distinct across live, movies and series, including category zero", async (t) => {
  const f = await fixture(t, {
    remoteData: async (input) => {
      const action = new URL(input).searchParams.get("action");
      return {
        get_live_streams: [{ stream_id: 1, name: "Channel", category_id: 4 }],
        get_vod_streams: [
          { stream_id: 2, name: "Movie", category_id: 4 },
          { stream_id: 3, name: "Unfiled", category_id: 0 },
        ],
        get_series: [{ series_id: 8, name: "Show", category_id: 4 }],
        get_live_categories: [{ category_id: 4, category_name: "News" }],
        get_vod_categories: [
          { category_id: 4, category_name: "Films" },
          { category_id: 0, category_name: "Other" },
        ],
        get_series_categories: [{ category_id: 4, category_name: "Drama" }],
      }[action];
    },
  });
  const id = f.add("xtream", {
    url: "https://iptv.example",
    username: "user",
    password: "secret",
  });
  const all = await (await f.request(`/api/catalog?connectionId=${id}`)).json();
  assert.equal(all.categories.length, 4);
  assert.deepEqual(
    Object.fromEntries(
      all.items.map((item) => [item.title, item.categoryLabel]),
    ),
    {
      Channel: "News",
      Movie: "Films",
      Unfiled: "Other",
      Show: "Drama",
    },
  );
  assert.deepEqual(
    new Set(all.categories.map((x) => x.id)),
    new Set(["movie:4", "movie:0", "series:4", "live:4"]),
  );
  for (const [category, title] of [
    ["live:4", "Channel"],
    ["movie:4", "Movie"],
    ["series:4", "Show"],
    ["movie:0", "Unfiled"],
  ]) {
    const list = await (
      await f.request(
        `/api/catalog?connectionId=${id}&category=${encodeURIComponent(category)}`,
      )
    ).json();
    assert.deepEqual(
      list.items.map((x) => x.title),
      [title],
    );
  }
  const legacy = await (
    await f.request(`/api/catalog?connectionId=${id}&kind=movie&category=4`)
  ).json();
  assert.deepEqual(
    legacy.items.map((x) => x.title),
    ["Movie"],
  );
});

test("Xtream next episode follows numeric season/episode order independently of search and pagination", async (t) => {
  const f = await fixture(t, {
    remoteData: async () => ({
      info: { series_id: 999, name: "Series" },
      episodes: {
        2: [
          { id: 23, episode_num: 3, title: "Season 2 end" },
          { id: 21, episode_num: 1, title: "Season 2 start" },
        ],
        10: [{ id: 101, episode_num: 1, title: "Season 10" }],
        1: [
          { id: 12, episode_num: 2, title: "Season 1 end" },
          { id: 11, episode_num: 1, title: "Pilot" },
        ],
      },
    }),
  });
  const id = f.add("xtream", {
    url: "https://iptv.example",
    username: "user",
    password: "secret",
  });
  const list = await (
    await f.request(`/api/catalog?connectionId=${id}&parentId=8&limit=1&page=2`)
  ).json();
  assert.equal(list.items[0].id, "8:12:mp4");
  assert.equal(list.hasMore, true);
  assert.deepEqual(
    list.categories.map((x) => x.name),
    ["Season 1", "Season 2", "Season 10"],
  );
  const next = await (
    await f.request(`/api/episodes/next?connectionId=${id}&itemId=8:12:mkv`)
  ).json();
  assert.equal(next.item.id, "8:21:mp4");
  assert.equal(next.item.seriesId, "8");
  assert.equal(next.item.seasonNumber, 2);
  assert.equal(next.item.episodeNumber, 1);
  const final = await (
    await f.request(`/api/episodes/next?connectionId=${id}&itemId=8:101:mp4`)
  ).json();
  assert.equal(final.item, null);
  assert.equal(
    (await f.request(`/api/episodes/next?connectionId=${id}&itemId=8:999:mp4`))
      .status,
    404,
  );
});

test("YouTube OAuth binds provider and session, preserves/rotates offline tokens, and refreshes after restart", async (t) => {
  const previous = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "https://tesplay.example";
  t.after(() => {
    if (previous === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previous;
  });
  let authorizations = 0;
  let refreshes = 0;
  const remoteData = async (input, options = {}) => {
    const u = new URL(input);
    if (u.hostname === "oauth2.googleapis.com") {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("client_secret"), "oauth-client-secret");
      if (body.get("grant_type") === "authorization_code") {
        authorizations++;
        assert.equal(
          body.get("redirect_uri"),
          "https://tesplay.example/api/youtube/callback",
        );
        assert.ok(body.get("code_verifier").length >= 43);
        return {
          access_token: "oauth-access-secret",
          ...(authorizations === 1
            ? { refresh_token: "oauth-refresh-secret" }
            : {}),
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.readonly",
        };
      }
      refreshes++;
      assert.equal(body.get("refresh_token"), "oauth-refresh-secret");
      return {
        access_token: "renewed-access-secret",
        refresh_token: "rotated-refresh-secret",
        expires_in: 3600,
      };
    }
    assert.equal(u.hostname, "www.googleapis.com");
    assert.equal(u.searchParams.has("key"), false);
    assert.equal(options.headers.Authorization, "Bearer renewed-access-secret");
    return {
      items: [
        {
          id: { videoId: "abcdefghijk" },
          snippet: { title: "Film", thumbnails: {} },
        },
      ],
    };
  };
  const f = await fixture(t, { remoteData });
  const id = f.add("youtube", {
    clientId: "oauth-client-id",
    clientSecret: "oauth-client-secret",
    authMode: "oauth",
    apiKey: "unused-api-secret",
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const begin = await f.request(`/api/youtube/auth?connectionId=${id}`, {
      redirect: "manual",
    });
    assert.equal(begin.status, 302);
    const authorization = new URL(begin.headers.get("location"));
    assert.equal(
      authorization.searchParams.get("scope"),
      "https://www.googleapis.com/auth/youtube.readonly",
    );
    assert.equal(authorization.searchParams.get("access_type"), "offline");
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    const query = `state=${authorization.searchParams.get("state")}&code=code`;
    assert.equal(
      (
        await f.request(`/api/youtube/callback?${query}`, {
          redirect: "manual",
          headers: { "X-Session": "other" },
        })
      ).status,
      400,
    );
    const callback = await f.request(`/api/youtube/callback?${query}`, {
      redirect: "manual",
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/?connected=youtube");
    assert.equal(
      (
        await f.request(`/api/youtube/callback?${query}`, {
          redirect: "manual",
        })
      ).status,
      400,
    );
    assert.equal(
      f.connections.get(id).config.refreshToken,
      "oauth-refresh-secret",
    );
  }
  f.connections.get(id).config.expiresAt = 0;
  const restarted = await fixture(t, {
    remoteData,
    connections: f.connections,
    key: f.key,
  });
  const catalog = await (
    await restarted.request(`/api/catalog?connectionId=${id}&q=film`)
  ).json();
  assert.equal(catalog.items[0].title, "Film");
  assert.ok(!JSON.stringify(catalog).includes("secret"));
  assert.equal(
    f.connections.get(id).config.refreshToken,
    "rotated-refresh-secret",
  );
  assert.equal(f.connections.get(id).config.authMode, "oauth");
  await restarted.request(`/api/connections/${id}/test`, { method: "POST" });
  assert.equal(refreshes, 1);
});

test('expired Google authorization reports reconnect instead of a gateway failure and recovers after reconnection', async t => {
  let refreshes = 0, fail = true;
  const f = await fixture(t, { remoteData: async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'oauth2.googleapis.com') {
      refreshes++;
      assert.equal(options.oauthToken, true);
      assert.ok(options.signal instanceof AbortSignal);
      if (fail) throw Object.assign(new Error('Provider returned HTTP 400. private-token'), { status: 502, oauthCode: 'invalid_grant' });
      return { access_token: 'new-access-secret', refresh_token: 'new-refresh-secret', expires_in: 3600 };
    }
    assert.equal(options.headers.Authorization, 'Bearer new-access-secret');
    return { items: [] };
  } });
  const id = f.add('youtube', { authMode: 'oauth', clientId: 'client', clientSecret: 'client-secret', accessToken: 'old-secret', refreshToken: 'revoked-secret', expiresAt: 0 });
  for (const endpoint of ['subscriptions', 'playlists', 'search?q=film']) {
    const response = await f.request(`/api/youtube/${id}/${endpoint}`);
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /authorization.*expired.*Connections.*reconnect/);
    assert.ok(!JSON.stringify(body).includes('secret'));
    assert.ok(!JSON.stringify(body).includes('private-token'));
  }
  fail = false;
  assert.equal((await f.request(`/api/youtube/${id}/subscriptions`)).status, 200);
  assert.equal(f.connections.get(id).config.refreshToken, 'new-refresh-secret');
  assert.equal(refreshes, 4);
});

test('parallel YouTube browsing shares one token refresh and persists its rotated token', async t => {
  let refreshes = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { remoteData: async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'oauth2.googleapis.com') {
      refreshes++; started(); await pending;
      return { access_token: 'shared-access-secret', refresh_token: 'rotated-secret', expires_in: 3600 };
    }
    assert.equal(options.headers.Authorization, 'Bearer shared-access-secret');
    return { items: [] };
  } });
  const id = f.add('youtube', { authMode: 'oauth', clientId: 'client', clientSecret: 'secret', refreshToken: 'old-refresh-secret', expiresAt: 0 });
  const responses = ['subscriptions', 'playlists', 'search?q=film'].map(endpoint => f.request(`/api/youtube/${id}/${endpoint}`));
  await ready;
  await new Promise(resolve => setImmediate(resolve));
  release();
  for (const response of await Promise.all(responses)) assert.equal(response.status, 200);
  assert.equal(refreshes, 1);
  assert.equal(f.connections.get(id).config.refreshToken, 'rotated-secret');
  assert.equal((await f.request(`/api/youtube/${id}/subscriptions`)).status, 200);
  assert.equal(refreshes, 1);
});

test('Google refresh retains server-wide OAuth client defaults after moving into the auth module', async t => {
  const previousId = process.env.GOOGLE_CLIENT_ID, previousSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = 'server-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'server-client-secret';
  t.after(() => {
    if (previousId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousSecret;
  });
  const f = await fixture(t, { remoteData: async (input, options = {}) => {
    if (new URL(input).hostname === 'oauth2.googleapis.com') {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_id'), 'server-client-id');
      assert.equal(body.get('client_secret'), 'server-client-secret');
      assert.equal(body.get('refresh_token'), 'existing-refresh-secret');
      return { access_token: 'renewed-access-secret', expires_in: 3600 };
    }
    assert.equal(options.headers.Authorization, 'Bearer renewed-access-secret');
    return { items: [] };
  } });
  const id = f.add('youtube', { authMode: 'oauth', refreshToken: 'existing-refresh-secret', expiresAt: 0 });
  assert.equal((await f.request(`/api/youtube/${id}/subscriptions`)).status, 200);
  assert.equal(f.connections.get(id).config.refreshToken, 'existing-refresh-secret');
  assert.equal(f.connections.get(id).config.clientSecret, undefined);
});

test('Google client configuration errors request a settings repair without changing transient failures', async t => {
  let oauthCode = 'invalid_client';
  const f = await fixture(t, { remoteData: async () => {
    throw Object.assign(new Error('Provider returned HTTP 503. Check the connection and permissions.'), { status: 502, oauthCode });
  } });
  const id = f.add('youtube', { authMode: 'oauth', refreshToken: 'secret' });
  const invalid = await f.request(`/api/youtube/${id}/subscriptions`);
  assert.equal(invalid.status, 409);
  assert.match((await invalid.json()).error, /client ID and secret in Connections/);
  oauthCode = undefined;
  const transient = await f.request(`/api/youtube/${id}/subscriptions`);
  assert.equal(transient.status, 502);
  assert.match((await transient.json()).error, /HTTP 503/);
});

test("YouTube explicit auth mode selects API key or OAuth without silent fallback", async (t) => {
  const f = await fixture(t, {
    remoteData: async (input, options = {}) => {
      const u = new URL(input);
      assert.equal(u.searchParams.get("key"), "active-api-key");
      assert.equal(options.headers?.Authorization, undefined);
      return { items: [] };
    },
  });
  const id = f.add("youtube", {
    authMode: "apiKey",
    apiKey: "active-api-key",
    accessToken: "unused-oauth-secret",
    expiresAt: Date.now() + 3600000,
  });
  assert.equal(
    (await f.request(`/api/catalog?connectionId=${id}`)).status,
    200,
  );
  f.connections.get(id).config = {
    authMode: "oauth",
    apiKey: "active-api-key",
  };
  assert.equal(
    (await f.request(`/api/catalog?connectionId=${id}`)).status,
    400,
  );
});

test('YouTube personal browsing uses OAuth, paginates subscriptions and opens channel uploads', async t => {
  const channel = 'UC' + 'a'.repeat(22), upload = 'UU' + 'a'.repeat(22);
  const f = await fixture(t, { stars:[{connectionId:'1',kind:'channel',id:channel,title:'Subscribed channel'}], remoteData: async (input, options) => {
    const u = new URL(input); assert.equal(options.headers.Authorization, 'Bearer google-secret'); assert.equal(u.searchParams.has('key'), false);
    if (u.pathname.endsWith('/subscriptions')) {
      assert.equal(u.searchParams.get('mine'), 'true');
      if (u.searchParams.get('pageToken') === 'next') return { items: [], pageInfo: { totalResults: 1 } };
      return { items: [{ snippet: { title: 'Subscribed channel', resourceId: { channelId: channel }, thumbnails: {} }, contentDetails: { totalItemCount: 9 } }], nextPageToken: 'next', pageInfo: { totalResults: 1 } };
    }
    if (u.pathname.endsWith('/channels')) return { items: [{ contentDetails: { relatedPlaylists: { uploads: upload } } }] };
    if (u.pathname.endsWith('/playlistItems')) {
      assert.equal(u.searchParams.get('playlistId'), upload);
      return { items: [{ contentDetails: { videoId: 'abcdefghijk', videoPublishedAt: '2026-09-30T10:00:00Z' }, snippet: { title: 'Channel upload', channelId: channel, thumbnails: {} } }] };
    }
    if (u.pathname.endsWith('/playlists')) return { items: [{ id: 'PLabcdefghijk', snippet: { title: 'My playlist' }, contentDetails: { itemCount: 5 } }] };
    throw Error('Unexpected request');
  } });
  const id = f.add('youtube', { authMode: 'oauth', accessToken: 'google-secret', expiresAt: Date.now() + 3600000 });
  const list = await (await f.request(`/api/youtube/${id}/subscriptions`)).json();
  assert.equal(list.channels[0].id, channel); assert.equal(list.nextPageToken, 'next');
  assert.deepEqual((await (await f.request(`/api/youtube/${id}/subscriptions?pageToken=next`)).json()).channels, []);
  const videos = await (await f.request(`/api/youtube/${id}/channel/${channel}/videos`)).json();
  assert.equal(videos.items[0].channelId, channel); assert.equal(videos.items[0].id, 'abcdefghijk');
  const feed = await (await f.request(`/api/youtube/${id}/feed`)).json();
  assert.equal(feed.items[0].title, 'Channel upload'); assert.equal(feed.basis, 'starred-subscriptions');
  const playlists = await (await f.request(`/api/youtube/${id}/playlists`)).json(); assert.equal(playlists.playlists[0].title, 'My playlist');
  assert.equal((await f.request(`/api/youtube/${id}/channel/bad/videos`)).status, 400);
  assert.equal((await f.request(`/api/youtube/${id}/feed?offset=-1`)).status, 400);
  assert.ok(!JSON.stringify({ list, videos, feed, playlists }).includes('google-secret'));
  const publicId = f.add('youtube', { authMode: 'apiKey', apiKey: 'secret' });
  assert.equal((await f.request(`/api/youtube/${publicId}/subscriptions`)).status, 409);
  assert.equal((await f.request(`/api/youtube/${publicId}/playlists`)).status, 409);
  assert.equal((await f.request(`/api/youtube/${publicId}/feed`)).status, 409);
});

test('YouTube search returns matching channels above videos with decoded titles and unchanged video IDs',async t=>{
 const calls=[],id='UC'+'a'.repeat(22);
 const f=await fixture(t,{remoteData:async input=>{const u=new URL(input);if(u.pathname.endsWith('/videos'))return {items:[{id:'abcdefghijk',contentDetails:{duration:'PT10M'}}]};calls.push(u.searchParams.get('type'));return u.searchParams.get('type')==='channel'?{items:[{id:{channelId:id},snippet:{title:'Channel &amp; Friends'}}]}:{items:[{id:{videoId:'abcdefghijk'},snippet:{title:'&#39;You&#39;re a Racist BIGOT!&#39;',channelTitle:'Channel &amp; Friends'}}],nextPageToken:'next'};}});
 const c=f.add('youtube',{authMode:'apiKey',apiKey:'fixture'});
 const data=await (await f.request(`/api/youtube/${c}/search?q=Channel`)).json();assert.deepEqual(calls.sort(),['channel','video']);assert.equal(data.channels[0].id,id);assert.equal(data.channels[0].title,'Channel & Friends');assert.equal(data.items[0].title,"'You're a Racist BIGOT!'");assert.equal(data.items[0].id,'abcdefghijk');assert.equal(data.nextPageToken,'next');
});

test('media requests reuse an authorized provider connection while forbidden addresses remain blocked',async t=>{
 if(!lan)return t.skip('No private LAN address');let opened=0;
 const server=http.createServer((req,res)=>res.end('segment'));server.on('connection',()=>opened++);await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://${lan}:${server.address().port}/segment`;
 for(let i=0;i<2;i++){const response=await requestRemote(url,{allowedPrivateHosts:[lan]});await new Promise((resolve,reject)=>{response.on('data',()=>{});response.once('end',resolve);response.once('error',reject);});}
 assert.equal(opened,1);await assert.rejects(requestRemote(url),/restricted network/);
});

test('IPTV Home chooses recent provided posters while browsing retains titles without artwork',async t=>{
  const f=await fixture(t,{remoteData:async input=>{
    const action=new URL(input).searchParams.get('action');
    if(new URL(input).hostname==='empty-art.example'&&action==='get_vod_streams')return [{stream_id:9,name:'No artwork supplied'}];
    if(action==='get_vod_streams')return [
      {stream_id:1,name:'Newest without artwork',added:'1900000000'},
      {stream_id:2,name:'Newest with artwork',added:'1800000000',stream_icon:'https://images.example/two.jpg'},
      {stream_id:3,name:'Older with artwork',added:'1700000000',stream_icon:'https://images.example/three.jpg'},
      {stream_id:4,name:'Invalid artwork',added:'1850000000',stream_icon:'http://127.0.0.1/private'},
    ];
    return [];
  }});
  const id=f.add('xtream',{url:'https://iptv.example',username:'user',password:'secret'});
  const normal=await(await f.request(`/api/catalog?connectionId=${id}&kind=movie&sort=recent`)).json();
  assert.equal(normal.items.length,4);assert.equal(normal.items[0].id,'1');
  const home=await(await f.request(`/api/catalog?connectionId=${id}&kind=movie&sort=recent&artwork=prefer`)).json();
  assert.deepEqual(home.items.map(i=>i.id),['2','3']);assert.ok(home.items.every(i=>i.poster.startsWith('/api/media/a_')));
  // A catalog entirely without artwork still remains usable on Home.
  f.connections.get(id).config.url='https://empty-art.example';
  const noArt=await(await f.request(`/api/catalog?connectionId=${id}&kind=movie&artwork=prefer`)).json();
  assert.equal(noArt.items[0].id,'9');
});
test('IPTV catalog stays cached across elapsed time; only explicit refresh refetches and failures retain it',async t=>{
  let calls=0,fail=false;
  const f=await fixture(t,{remoteData:async input=>{
    const action=new URL(input).searchParams.get('action');
    if(action==='get_vod_streams'){calls++;if(fail)throw Object.assign(new Error('Unavailable'),{status:524});return [{stream_id:calls,name:'Film '+calls}];}
    return [];
  }});
  const id=f.add('xtream',{url:'https://iptv.example',username:'user',password:'secret'}),endpoint=`/api/catalog?connectionId=${id}&kind=movie`;
  assert.equal((await(await f.request(endpoint)).json()).items[0].title,'Film 1');
  const original=Date.now;Date.now=()=>original()+10*60_000;
  try{assert.equal((await(await f.request(endpoint)).json()).items[0].title,'Film 1');assert.equal(calls,1);}finally{Date.now=original;}
  fail=true;assert.equal((await f.request(endpoint+'&refresh=1')).status,524);
  assert.equal((await(await f.request(endpoint)).json()).items[0].title,'Film 1');assert.equal(calls,2);
  fail=false;assert.equal((await(await f.request(endpoint+'&refresh=1')).json()).items[0].title,'Film 3');
  f.connections.get(id).config.password='new-secret';
  assert.equal((await(await f.request(endpoint)).json()).items[0].title,'Film 4');
});

test('a pending manual IPTV refresh does not delay readers of the saved catalog',async t=>{
  let release,started,refreshing=false;
  const ready=new Promise(r=>{started=r;}),f=await fixture(t,{remoteData:async input=>{
    if(new URL(input).searchParams.get('action')!=='get_vod_streams')return [];
    if(refreshing){started();await new Promise(r=>{release=r;});return [{stream_id:2,name:'New film'}];}
    return [{stream_id:1,name:'Saved film'}];
  }});
  const id=f.add('xtream',{url:'https://iptv.example'}),endpoint=`/api/catalog?connectionId=${id}&kind=movie`;
  await f.request(endpoint);refreshing=true;
  const update=f.request(endpoint+'&refresh=1');await ready;
  try{
    const read=await f.request(endpoint,{signal:AbortSignal.timeout(1000)});
    assert.equal((await read.json()).items[0].title,'Saved film');
  }finally{release();await update;}
  assert.equal((await(await f.request(endpoint)).json()).items[0].title,'New film');
});

test('YouTube browsing adds durations in one batched metadata call and leaves unknown durations visible',async t=>{
  const calls=[],channel='UC'+'a'.repeat(22);
  const f=await fixture(t,{remoteData:async input=>{const u=new URL(input);calls.push(u.pathname);if(u.pathname.endsWith('/channels'))return {items:[{contentDetails:{relatedPlaylists:{uploads:'UU'+'a'.repeat(22)}}}]};if(u.pathname.endsWith('/playlistItems'))return {items:[{contentDetails:{videoId:'abcdefghijk'},snippet:{title:'Short',channelId:channel}},{contentDetails:{videoId:'lmnopqrstuv'},snippet:{title:'Long',channelId:channel}},{contentDetails:{videoId:'zzzzzzzzzzz'},snippet:{title:'Unknown',channelId:channel}}]};if(u.pathname.endsWith('/videos')){assert.equal(u.searchParams.get('part'),'contentDetails');return {items:[{id:'abcdefghijk',contentDetails:{duration:'PT3M'}},{id:'lmnopqrstuv',contentDetails:{duration:'PT1H2M3S'}}]};}throw Error('Unexpected request');}});
  const id=f.add('youtube',{authMode:'apiKey',apiKey:'secret'});
  const result=await(await f.request(`/api/youtube/${id}/channel/${channel}/videos`)).json();assert.equal(result.items[0].duration,180);assert.equal(result.items[1].duration,3723);assert.equal(result.items[2].duration,undefined);assert.equal(calls.filter(p=>p.endsWith('/videos')).length,1);
});

test("YouTube playback resolves through InnerTube first and keeps yt-dlp as the fallback", async (t) => {
  const calls = [];
  const innertube = {
    mode: (c) => c.config.authMode === 'innertube',
    test: async () => true,
    resolve: async (_req, c, id) => {
      calls.push(['innertube', c?.id, id]);
      if (id === 'abcdefghijk') return { via: 'innertube-tv', isLive: false, video: { url: 'https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&sig=private', headers: {} }, audio: { url: 'https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&sig=private', headers: {} } };
      if (id === 'liveliveliv') return { isLive: true };
      return null;
    },
  };
  const f = await fixture(t, {
    innertube,
    resolveYouTube: async (id) => {
      calls.push(['yt-dlp', id]);
      return { video: { url: 'https://test.googlevideo.com/live.m3u8', headers: {}, hls: true }, audio: null, isLive: id === 'liveliveliv' };
    },
  });
  const id = f.add('youtube', { authMode: 'innertube', tvRefreshToken: 'rt' });
  const direct = await (await f.request(`/api/playback?connectionId=${id}&itemId=abcdefghijk`)).json();
  assert.equal(direct.streamKind, 'dual-input');
  assert.equal(direct.via, 'innertube-tv');
  assert.match(direct.url, /^\/api\/media\//);
  assert.match(direct.audioUrl, /^\/api\/media\//);
  assert.ok(!JSON.stringify(direct).includes('private'));
  const live = await (await f.request(`/api/playback?connectionId=${id}&itemId=liveliveliv`)).json();
  assert.equal(live.type, 'hls');
  assert.equal(live.isLive, true);
  assert.equal(live.streamKind, 'direct-file');
  const fallback = await (await f.request(`/api/playback?connectionId=${id}&itemId=zzzzzzzzzzz`)).json();
  assert.equal(fallback.type, 'hls');
  assert.deepEqual(calls, [['innertube', id, 'abcdefghijk'], ['innertube', id, 'liveliveliv'], ['yt-dlp', 'liveliveliv'], ['innertube', id, 'zzzzzzzzzzz'], ['yt-dlp', 'zzzzzzzzzzz']]);
  assert.equal((await f.request(`/api/connections/${id}/test`, { method: 'POST' })).status, 200);
});
