import { assertAllowed } from "./access.js";
import { categoryLoaded } from './iptv-selection.js';
import { cleanText, httpError, validateMediaItem } from "./security.js";
import { isRetiredConnection } from "./connection-routes.js";
export function createLibraryContext(store, { getProfileId, getConnection }) {
  // Saved titles and stars of a connection type TesPlay no longer offers stay
  // in the database but are not shown: they can no longer be opened.
  const usable = (req, item) => {
    if (!item?.connectionId) return true;
    try { return !isRetiredConnection(store.visibleConnection(req.user.id, item.connectionId)); }
    catch { return true; }
  };
  const visible = (req, item) => store.visibleItem(req.user.id, item) && usable(req, item);
  const stars = (req) =>
    store.stars(getProfileId(req)).filter((s) => {
      try {
        const c = store.visibleConnection(req.user.id, s.connectionId);
        if (isRetiredConnection(c)) return false;
        if (
          s.kind === "section" &&
          c.access?.sections &&
          !c.access.sections.includes(s.id)
        )
          return false;
        if (
          s.kind === "category" &&
          c.access?.categories &&
          !c.access.categories.includes(s.id)
        )
          return false;
        if (
          s.kind === "category" &&
          c.type === "xtream" &&
          c.access &&
          !c.access.kinds.includes(s.id.split(":")[0])
        )
          return false;
        return true;
      } catch {
        return false;
      }
    });
  function visibleLibrary(req) {
    const state = store.libraryState(getProfileId(req));
    const normalize = (i) => {
      const c = i.connectionId
        ? store.visibleConnection(req.user.id, i.connectionId)
        : null;
      return {
        ...i,
        ...(c
          ? {
              providerType: c.type,
              source: c.type === "youtube" ? "YouTube" : i.source,
            }
          : {}),
      };
    };
    return {
      ...state,
      favorites: state.favorites
        .filter((i) => visible(req, i))
        .map(normalize),
      progress: state.progress
        .filter((p) => visible(req, p.item))
        .map((p) => ({ ...p, item: normalize(p.item) })),
      stars: stars(req),
      queue: store
        .queue(getProfileId(req))
        .filter((i) => visible(req, i))
        .map(normalize),
    };
  }
  function ownedItem(req) {
    const item = validateMediaItem(req.body?.item);
    if (item.providerType === "remote-media") throw httpError(400, "Videos sent from a phone are no longer supported.");
    if (item.connectionId) {
      const c = getConnection(req, item.connectionId);
      if (!categoryLoaded(c, item)) throw httpError(403, 'This category is not loaded. Enable it in IPTV settings.');
      assertAllowed(c.access, item);
    } else if (req.user.role !== "owner")
      throw httpError(403, "Choose a title from a shared connection.");
    return item;
  }
  return { stars, visibleLibrary, ownedItem };
}

export function registerLibraryRoutes(
  app,
  { store, ctx, getProfileId, visibleLibrary, ownedItem },
) {
  app.get("/api/library/state", (req, res) => res.json(visibleLibrary(req)));
  function verifyProfile(req) {
    if (
      req.body?.profileId !== undefined &&
      req.body.profileId !== getProfileId(req)
    )
      throw httpError(
        409,
        "The active profile changed. Try again in this profile.",
      );
  }
  app.post("/api/library/favorites", (req, res) => {
    verifyProfile(req);
    const item = ownedItem(req);
    res.json({
      favorites: store.toggleFavorite(getProfileId(req), item),
    });
  });
  app.post("/api/library/progress", async (req, res) => {
    if (
      req.body?.profileId !== undefined &&
      req.body.profileId !== getProfileId(req)
    )
      throw httpError(
        409,
        "The active profile changed. Reopen the title to continue.",
      );
    const item = ownedItem(req);
    const { seconds, duration } = req.body;
    if (
      !Number.isFinite(seconds) ||
      !Number.isFinite(duration) ||
      seconds < 0 ||
      duration < 0 ||
      seconds > 604800 ||
      duration > 604800 ||
      (duration > 0 && seconds > duration + 5)
    )
      throw httpError(
        400,
        "Playback progress must be a valid position and duration in seconds.",
      );
    store.saveProgress(getProfileId(req), item, seconds, duration);
    res.json({ ok: true });
  });
  app.post("/api/library/stars", (req, res) => {
    verifyProfile(req);
    const value = req.body;
    if (!["category", "channel"].includes(value?.kind))
      throw httpError(400, "Choose a channel or category to star.");
    const c = ctx.getConnection(req, value.connectionId);
    const id = cleanText(value.id, "Star ID", 200),
      title = cleanText(value.title, "Star name", 200);
    if (
      value.kind === "channel" &&
      (c.type !== "youtube" || !/^UC[A-Za-z0-9_-]{22}$/.test(id))
    )
      throw httpError(400, "Choose a YouTube channel.");
    if (value.kind === "category" && !["xtream", "m3u"].includes(c.type))
      throw httpError(400, "Choose an IPTV category.");
    res.json({
      stars: store.toggleStar(getProfileId(req), {
        connectionId: c.id,
        kind: value.kind,
        id,
        title,
      }),
    });
  });
  app.post("/api/library/queue", (req, res) => {
    verifyProfile(req);
    const action = req.body?.action;
    const item = action === "clear" ? null : ownedItem(req);
    if (item && ["series", "folder"].includes(item.type))
      throw httpError(400, "Choose a playable title for your queue.");
    if (
      item?.connectionId &&
      ctx.getConnection(req, item.connectionId).type === "youtube" &&
      (item.type !== "video" || !/^[A-Za-z0-9_-]{11}$/.test(item.id))
    )
      throw httpError(400, "Choose a YouTube video for your playlist.");
    store.updateQueue(getProfileId(req), action, item);
    res.json({ queue: visibleLibrary(req).queue });
  });
}
