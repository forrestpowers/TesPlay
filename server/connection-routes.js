import { cleanText, httpError } from "./security.js";
import { validateLoadedCategories } from './iptv-selection.js';

const supportedConnections = ["xtream", "m3u", "youtube"];
// Connection types TesPlay no longer offers. Saved rows of these types still
// list in Settings so they can be removed, but nothing browses or plays them.
const retiredConnections = {
  plex: "Plex",
  stremio: "Stremio",
  drive: "Google Drive",
  local: "Server folder",
};
export const isRetiredConnection = (c) => Object.hasOwn(retiredConnections, c?.type);
export function assertSupportedConnection(c) {
  if (isRetiredConnection(c))
    throw httpError(410, `${retiredConnections[c.type]} connections are no longer supported. Remove it in Settings.`);
  return c;
}
const editablePublicConfigFields = new Set([
  "tvClientId",
  "authMode",
]);

export function validateConnection(value, existing) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw httpError(400, "Connection details are required.");
  const type = existing?.type ?? value.type;
  if (!supportedConnections.includes(type))
    throw httpError(400, "This connection type is not supported.");
  if (existing && value.type && value.type !== existing.type)
    throw httpError(400, "Connection types cannot be changed.");
  const name =
    value.name === undefined && existing
      ? existing.name
      : cleanText(value.name || type, "Connection name", 80);
  const config = value.config ?? (existing ? undefined : {});
  if (
    config !== undefined &&
    (!config || typeof config !== "object" || Array.isArray(config))
  )
    throw httpError(400, "Connection settings must be a JSON object.");
  const merged = { ...(existing?.config ?? {}), ...(config ?? {}) };
  validateLoadedCategories(type, merged.loadedCategories);
  const { content, ...otherSettings } = merged;
  if (type === "m3u" && content !== undefined) {
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content, "utf8") > 20 * 1024 * 1024
    )
      throw httpError(400, "Choose a playlist no larger than 20 MB.");
    if (Buffer.byteLength(JSON.stringify(merged), "utf8") > 21 * 1024 * 1024)
      throw httpError(
        400,
        "The encoded playlist settings are larger than 21 MB.",
      );
    if (Buffer.byteLength(JSON.stringify(otherSettings), "utf8") > 24_000)
      throw httpError(
        400,
        "Other connection settings must be smaller than 24 KB.",
      );
  } else if (Buffer.byteLength(JSON.stringify(merged), "utf8") > 24_000)
    throw httpError(400, "Connection settings must be smaller than 24 KB.");
  return { type, name, ...(config === undefined ? {} : { config }) };
}

export function createConnectionContext(store) {
  function getManagedConnection(req, id) {
    const c = store.visibleConnection(req.user.id, id);
    if (c.shared) throw httpError(403, 'Only the connection owner can manage this shared connection.');
    return c;
  }
  return {
    getManagedConnection,
    getConnection(req, id) {
      return assertSupportedConnection(store.visibleConnection(req.user.id, id));
    },
    listConnections(req) {
      return store.visibleConnections(req.user.id, true);
    },
    saveConnection(req, value, { allowShared = false } = {}) {
      const existing = value.id
        ? (allowShared ? store.visibleConnection(req.user.id, value.id) : getManagedConnection(req, value.id))
        : null;
      return store.saveConnection(existing?.ownerId || req.user.id, {
        ...validateConnection(value, existing),
        ...(value.id ? { id: value.id } : {}),
      });
    },
  };
}

export function registerConnectionRoutes(app, { store, ctx, requireOwner }) {
  // IPTV movies and series are mostly H.265, which the car cannot decode; they are offered
  // only when the server sets IPTV_ON_DEMAND=1, and the app hides them otherwise.
  const iptvOnDemand = process.env.IPTV_ON_DEMAND === "1";
  app.get("/api/connections", (req, res) =>
    res.json({ connections: store.visibleConnections(req.user.id).map(c => c.type === "xtream" ? { ...c, onDemand: iptvOnDemand } : c) }),
  );
  app.get("/api/connections/:id/config", requireOwner, (req, res) => {
    const { config, ...connection } = ctx.getManagedConnection(req, req.params.id);
    res.json({
      connection,
      config: Object.fromEntries(
        Object.entries(config).filter(
          ([key, value]) =>
            editablePublicConfigFields.has(key) &&
            ["string", "boolean", "number"].includes(typeof value),
        ),
      ),
      configuredFields: Object.keys(config).filter(
        (key) => config[key] !== "" && config[key] != null,
      ),
    });
  });
  app.post("/api/connections", requireOwner, (req, res) =>
    res.status(201).json({ connection: ctx.saveConnection(req, req.body) }),
  );
  app.put("/api/connections/:id", requireOwner, (req, res) => {
    const existing = ctx.getManagedConnection(req, req.params.id);
    // Saved passwords, URLs containing credentials, and OAuth tokens are never
    // returned to the form. Leaving their edit fields blank preserves them.
    const config = req.body?.config;
    const safeUpdate =
      config && typeof config === "object" && !Array.isArray(config)
        ? Object.fromEntries(
            Object.entries(config).filter(
              ([key, value]) =>
                editablePublicConfigFields.has(key) ||
                !(typeof value === "string" && value.trim() === ""),
            ),
          )
        : config;
    if (
      existing.type === "youtube" &&
      safeUpdate &&
      typeof safeUpdate === "object" &&
      ["tvClientId", "tvClientSecret"].some(
        (field) =>
          Object.hasOwn(safeUpdate, field) &&
          safeUpdate[field] !== existing.config[field],
      )
    ) {
      // Device-flow tokens belong to the TV OAuth client that issued them.
      safeUpdate.tvAccessToken = null;
      safeUpdate.tvRefreshToken = null;
      safeUpdate.tvExpiresAt = 0;
    }
    res.json({
      connection: ctx.saveConnection(req, {
        ...req.body,
        ...(config !== undefined ? { config: safeUpdate } : {}),
        id: req.params.id,
      }),
    });
  });
  app.delete("/api/connections/:id", requireOwner, (req, res) => {
    ctx.getManagedConnection(req, req.params.id);
    store.deleteConnection(req.user.id, req.params.id);
    res.json({ ok: true });
  });
}
