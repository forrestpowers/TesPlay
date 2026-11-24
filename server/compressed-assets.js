// The app's built scripts and styles are served compressed: the player code alone is about
// 690 KB as built and about 230 KB with gzip, which matters on a car's mobile connection.
// Built asset names carry a content hash, so each file is compressed once and kept in memory,
// and browsers may keep it for a year.
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const brotli = promisify(brotliCompress), gz = promisify(gzip);
const TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const MIN_BYTES = 1024, MAX_BYTES = 8 * 1024 * 1024, MAX_ENTRIES = 400;

/** Express middleware for a hashed asset directory (mounted at its URL prefix); later roots are fallbacks. */
export function compressedAssets(roots, { cacheControl = 'public, max-age=31536000, immutable' } = {}) {
  const directories = roots.filter(Boolean).map(root => resolve(root));
  const cache = new Map(); // absolute path -> Promise<{ br, gzip } | null>
  const load = file => {
    let entry = cache.get(file);
    if (!entry) {
      entry = (async () => {
        const info = await stat(file).catch(() => null);
        if (!info?.isFile() || info.size < MIN_BYTES || info.size > MAX_BYTES) return null;
        const raw = await readFile(file);
        const [br, gzipped] = await Promise.all([
          brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
          gz(raw, { level: 9 }),
        ]);
        return { br, gzip: gzipped };
      })();
      // A file that is missing now may be written by the next deployment; only remember hits.
      entry.then(value => { if (!value) cache.delete(file); }, () => cache.delete(file));
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(file, entry);
    }
    return entry;
  };
  return async (req, res, next) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const type = TYPES[extname(req.path).toLowerCase()];
      const accepted = String(req.headers['accept-encoding'] || '');
      const encoding = /\bbr\b/.test(accepted) ? 'br' : /\bgzip\b/.test(accepted) ? 'gzip' : null;
      if (!type || !encoding) return next();
      let relative;
      try { relative = decodeURIComponent(req.path); } catch { return next(); }
      for (const directory of directories) {
        const file = resolve(directory, `.${relative}`);
        if (!file.startsWith(directory + sep)) return next();
        const entry = await load(file).catch(() => null);
        if (!entry) continue;
        const body = entry[encoding];
        res.set({ 'Content-Type': type, 'Content-Encoding': encoding, 'Content-Length': String(body.length), 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' });
        return req.method === 'HEAD' ? res.end() : res.end(body);
      }
      next();
    } catch (error) { next(error); }
  };
}
