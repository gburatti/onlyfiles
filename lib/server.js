// Local HTTP server for the browser UI.
//
// Security notes, because this process exposes an API that can delete files:
//
//  * It binds to 127.0.0.1 only, so nothing off-machine can reach it.
//  * Every request must carry a random per-run token. Without this, any website
//    open in the same browser could POST to http://localhost:<port>/api/delete —
//    the classic localhost CSRF hole. The token lives in the URL the UI is
//    opened with and is echoed back in a header.
//  * The Host header must be a loopback name, which blocks DNS rebinding.
//  * Deletion additionally goes through assertDeletable() in fsops.js.

import { createServer } from 'node:http';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import {
  children, findNode, largestFiles, largestDirs, byExtension, suspects, search,
  staleDirs, detachPath, shape, shallowest,
} from './tree.js';
import { REPORTS, formatBytes } from './report.js';
import { deletePath, revealInFileManager, openPath, UnsafePathError, fileManagerName } from './fsops.js';
import { scan, diskFree } from './scanner.js';

const UI_HTML = new URL('../ui/index.html', import.meta.url);
// The OF monogram is all cyan, so one file serves both themes. The wordmark
// contains a near-black "Only", so it needs a variant per theme.
const STATIC = {
  '/favicon.png': ['../assets/icon-64.png', 'image/png'],
  '/icon.png': ['../assets/icon-512.png', 'image/png'],
  '/logo-dark.png': ['../assets/logo-header-dark.png', 'image/png'],
  '/logo-light.png': ['../assets/logo-header-light.png', 'image/png'],
};
const TOKEN_HEADER = 'x-onlyfiles-token';

export function createOnlyFilesServer(state, opts = {}) {
  const { readOnly = false } = opts;
  const token = randomBytes(16).toString('hex');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // --- DNS rebinding guard ------------------------------------------------
    const host = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1', '[::1]', '::1', ''].includes(host)) {
      return send(res, 403, { error: 'Bad Host header' });
    }

    try {
      // The HTML shell is the one thing served without a token, because the
      // browser fetches it from a plain URL. It contains no data by itself.
      if (path === '/' || path === '/index.html') {
        const html = readFileSync(UI_HTML, 'utf8')
          .replace('__ONLYFILES_TOKEN__', token)
          .replace('__ONLYFILES_READONLY__', String(readOnly))
          .replace('__ONLYFILES_FILEMANAGER__', fileManagerName);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      // No token: these are static images carrying no data, and the browser
      // requests them without our headers anyway.
      const asset = STATIC[path] || (path === '/favicon.ico' ? STATIC['/favicon.png'] : null);
      if (asset) {
        try {
          const bytes = readFileSync(new URL(asset[0], import.meta.url));
          res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'max-age=86400' });
          return res.end(bytes);
        } catch {
          return send(res, 404, { error: `Missing asset ${path}` });
        }
      }

      if (!path.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

      // --- token check ------------------------------------------------------
      const given = req.headers[TOKEN_HEADER] || url.searchParams.get('t');
      if (given !== token) return send(res, 401, { error: 'Bad or missing token' });

      const body = req.method === 'POST' ? await readJson(req) : {};
      return await route(path, url, req, res, body);
    } catch (err) {
      if (err instanceof UnsafePathError) return send(res, 400, { error: err.message });
      return send(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  async function route(path, url, req, res, body) {
    const q = url.searchParams;
    const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);

    switch (path) {
      case '/api/status':
        return send(res, 200, {
          scanning: state.scanning,
          progress: state.progress,
          stats: state.stats,
          rootPath: state.rootPath,
          readOnly,
          fileManager: fileManagerName,
          // The UI abbreviates the home prefix to "~" so more of the meaningful
          // tail of a path fits on screen. Full paths stay in the tooltip and on
          // the clipboard.
          home: homedir(),
          disk: state.stats ? state.stats.disk : diskFree(state.rootPath || '/'),
          deleted: state.deleted,
          // Without this a bad path would leave the progress overlay spinning
          // with nothing to report.
          error: state.error,
        });

      case '/api/children': {
        requireScan(state);
        const target = q.get('path') || state.root.n;
        const data = children(state.root, target, {
          offset: num('offset', 0),
          limit: num('limit', 500),
        });
        if (!data) return send(res, 404, { error: `Not in the scan: ${target}` });
        return send(res, 200, data);
      }

      // A live re-read of one directory, listing every entry no matter how
      // small. The cached tree groups tiny files together to stay compact; this
      // is the escape hatch for genuine file-by-file detail.
      case '/api/listing': {
        const target = resolve(q.get('path') || '.');
        let entries;
        try {
          entries = readdirSync(target, { withFileTypes: true });
        } catch (err) {
          return send(res, 400, { error: `Cannot read ${target}: ${err.message}` });
        }
        const items = [];
        for (const e of entries) {
          const full = join(target, e.name);
          try {
            const st = lstatSync(full);
            const isDir = e.isDirectory() && !e.isSymbolicLink();

            // lstat on a directory returns the size of the directory inode —
            // a few kilobytes — not of its contents. Sorting on that would rank
            // a stray .DS_Store above a 4 GB folder, so take the recursive total
            // from the scan for directories and only trust lstat for files.
            const scanned = state.root ? findNode(state.root, full) : null;
            const size = isDir
              ? (scanned ? scanned.s : null)
              : (st.blocks > 0 ? st.blocks * 512 : st.size);

            items.push({
              name: e.name,
              path: full,
              size,
              logical: isDir && scanned ? scanned.l : st.size,
              isDir,
              isSymlink: e.isSymbolicLink(),
              mtime: Math.round(st.mtimeMs / 1000),
              links: st.nlink,
              files: isDir && scanned ? scanned.f : 0,
              // A folder created since the scan has no total to show.
              unscanned: isDir && !scanned,
            });
          } catch { /* vanished or unreadable; skip it */ }
        }
        items.sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
        return send(res, 200, { path: target, total: items.length, items, live: true });
      }

      // Lists just the subdirectories of one folder, so the UI can offer a
      // navigable picker. The browser cannot hand us a real filesystem path from
      // a file input, so path selection has to be driven from this side.
      case '/api/browse': {
        const target = resolve(q.get('path') || homedir());
        let st;
        try {
          st = lstatSync(target);
        } catch (err) {
          return send(res, 400, { error: `Cannot read ${target}: ${err.message}` });
        }
        if (!st.isDirectory()) return send(res, 400, { error: `Not a folder: ${target}` });

        let dirs = [];
        let unreadable = false;
        try {
          for (const e of readdirSync(target, { withFileTypes: true })) {
            if (!e.isDirectory() || e.isSymbolicLink()) continue;
            dirs.push({ name: e.name, path: join(target, e.name), hidden: e.name.startsWith('.') });
          }
        } catch {
          // Listable-but-not-readable is worth showing rather than erroring on:
          // the folder can still be chosen as a scan root.
          unreadable = true;
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));

        const home = homedir();
        const presets = [
          { label: 'Home', path: home },
          { label: 'Whole disk', path: '/' },
          { label: 'Applications', path: '/Applications' },
          { label: 'Library', path: join(home, 'Library') },
          { label: 'Downloads', path: join(home, 'Downloads') },
        ].filter((pr) => { try { return lstatSync(pr.path).isDirectory(); } catch { return false; } });

        // External and network volumes have to be scanned as their own root,
        // because /Volumes is skipped during a scan of /.
        try {
          for (const e of readdirSync('/Volumes', { withFileTypes: true })) {
            if (e.isDirectory()) presets.push({ label: e.name, path: join('/Volumes', e.name), volume: true });
          }
        } catch { /* no /Volumes on this platform */ }

        const parent = dirname(target);
        return send(res, 200, {
          path: target,
          parent: parent === target ? null : parent,
          dirs,
          unreadable,
          presets,
          disk: diskFree(target),
          scanning: state.scanning,
          current: state.rootPath,
        });
      }

      case '/api/largest-files':
        requireScan(state);
        return send(res, 200, { items: largestFiles(state.root, num('limit', 200)) });

      case '/api/largest-dirs':
        requireScan(state);
        return send(res, 200, { items: largestDirs(state.root, num('limit', 200)) });

      case '/api/kinds':
        requireScan(state);
        return send(res, 200, { items: byExtension(state.root, num('limit', 60)) });

      case '/api/suspects':
        requireScan(state);
        return send(res, 200, { items: suspects(state.root) });

      case '/api/stale':
        requireScan(state);
        return send(res, 200, {
          items: shallowest(staleDirs(state.root, {
            olderThanDays: num('days', 365),
            limit: num('limit', 400),
            minSize: num('minSize', 50 * 1024 * 1024),
          })).slice(0, num('limit', 100)),
        });

      case '/api/search':
        requireScan(state);
        return send(res, 200, { items: search(state.root, q.get('q') || '', num('limit', 300)) });

      case '/api/report': {
        requireScan(state);
        const fmt = q.get('format') || 'md';
        const spec = REPORTS[fmt];
        if (!spec) return send(res, 400, { error: `Unknown format: ${fmt}` });
        const depth = q.has('depth') ? Number(q.get('depth')) : fmt === 'md' ? 4 : Infinity;
        const name = `onlyfiles-${basename(state.root.n) || 'root'}-${stamp()}.${spec.ext}`;
        res.writeHead(200, {
          'content-type': spec.mime,
          'content-disposition': `attachment; filename="${name}"`,
        });
        // Stream: a full-home CSV is hundreds of megabytes of text.
        for (const chunk of spec.gen(state.root, state.stats, { maxDepth: depth })) {
          if (!res.write(chunk)) {
            await new Promise((r) => res.once('drain', r));
          }
        }
        return res.end();
      }

      case '/api/reveal': {
        const ok = await revealInFileManager(String(body.path || ''));
        return send(res, 200, { ok });
      }

      case '/api/open': {
        const ok = await openPath(String(body.path || ''));
        return send(res, 200, { ok });
      }

      case '/api/delete': {
        requireScan(state);
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });

        const paths = Array.isArray(body.paths) ? body.paths : [];
        const mode = body.mode === 'permanent' ? 'permanent' : 'trash';
        if (!paths.length) return send(res, 400, { error: 'No paths given' });

        const results = [];
        let freed = 0;
        for (const p of paths) {
          const node = findNode(state.root, resolve(String(p)));
          const size = node ? node.s : 0;
          try {
            await deletePath(String(p), state.root.n, { mode, readOnly });
            detachPath(state.root, resolve(String(p)));
            freed += size;
            state.deleted.count++;
            state.deleted.bytes += size;
            results.push({ path: p, ok: true, mode, size });
          } catch (err) {
            results.push({ path: p, ok: false, error: String(err.message || err) });
          }
        }
        return send(res, 200, {
          results,
          freed,
          freedHuman: formatBytes(freed),
          rootSize: state.root.s,
          disk: diskFree(state.root.n),
        });
      }

      case '/api/rescan': {
        if (state.scanning) return send(res, 409, { error: 'A scan is already running' });
        const target = body.path ? resolve(String(body.path)) : state.rootPath;
        const minFileSize = body.minFileSize !== undefined ? Number(body.minFileSize) : state.minFileSize;

        // Fail fast on a bad path rather than starting a scan that throws
        // asynchronously and leaves the UI waiting.
        try {
          if (!lstatSync(target).isDirectory()) {
            return send(res, 400, { error: `Not a folder: ${target}` });
          }
        } catch (err) {
          return send(res, 400, { error: `Cannot read ${target}: ${err.message}` });
        }
        // Fire and forget: the UI polls /api/status for progress.
        startScan(state, target, { ...state.scanOpts, minFileSize });
        return send(res, 202, { started: true, path: target });
      }

      default:
        return send(res, 404, { error: 'Not found' });
    }
  }

  server.token = token;
  return server;
}

function requireScan(state) {
  if (!state.root) {
    const err = new Error(state.scanning ? 'Scan still running' : 'No scan loaded yet');
    err.statusCode = 409;
    throw err;
  }
}

/** Kick off a scan, updating `state` as it goes. */
export function startScan(state, rootPath, opts = {}) {
  state.scanning = true;
  state.error = null; // clear any failure from a previous attempt
  state.rootPath = rootPath;
  state.minFileSize = opts.minFileSize ?? 0;
  state.scanOpts = opts;
  state.progress = { files: 0, dirs: 0, bytes: 0, errors: 0, phase: 'starting', queued: 0, done: 0 };

  const promise = scan(rootPath, {
    ...opts,
    onProgress: (p) => {
      state.progress = p;
      opts.onProgress?.(p);
    },
  })
    .then(({ root, stats }) => {
      state.root = root;
      state.stats = stats;
      state.scanning = false;
      state.progress = { ...state.progress, phase: 'done' };
      return { root, stats };
    })
    .catch((err) => {
      state.scanning = false;
      state.error = String(err.message || err);
      state.progress = { ...state.progress, phase: 'error' };
      throw err;
    });

  state.current = promise;
  return promise;
}

export function newState() {
  return {
    scanning: false,
    root: null,
    stats: null,
    rootPath: null,
    minFileSize: 0,
    progress: null,
    error: null,
    deleted: { count: 0, bytes: 0 },
  };
}

function send(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((res, rej) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e7) rej(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!data) return res({});
      try {
        res(JSON.parse(data));
      } catch {
        rej(new Error('Invalid JSON body'));
      }
    });
    req.on('error', rej);
  });
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}
