// Scan orchestration.
//
// A single-threaded walk of a cold filesystem is latency-bound on lstat, not
// CPU-bound, so it parallelises well. The main thread walks the top few levels
// to produce a "frontier" of subtree roots, then a pool of workers pulls those
// off a queue. Deep, lopsided trees (a 200k-file Library next to a 3-file
// Documents) stay balanced because there are far more tasks than workers.

import { Worker } from 'node:worker_threads';
import { lstatSync, statfsSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve, sep } from 'node:path';
import { walkDir, makeCtx, rollup, TYPE_DIR } from './walk.js';
import { LinkSet } from './linkset.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

/**
 * Paths that are never worth descending into: synthetic filesystems, mount
 * points for other volumes, and the firmlink that would make a scan of `/`
 * traverse the whole data volume a second time.
 */
export function defaultSkips() {
  return [
    '/System/Volumes', // firmlinks — /System/Volumes/Data is the data volume
    '/Volumes', // other mounted disks
    '/dev',
    '/net',
    '/home', // autofs
    '/proc',
    '/sys',
    '/private/var/vm', // swap files: huge, transient, not user-reclaimable
  ];
}

export function diskFree(path) {
  try {
    const st = statfsSync(path);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

/**
 * Scan `rootPath` and return { root, stats }.
 *
 * onProgress receives { files, dirs, bytes, errors, phase, queued, done }
 * roughly ten times a second.
 */
export async function scan(rootPath, opts = {}) {
  const root = resolve(rootPath);
  const {
    minFileSize = 0,
    frontierDepth = 4,
    concurrency = Math.max(1, Math.min(8, cpus().length - 2)),
    crossDevice = false,
    onProgress = () => {},
  } = opts;

  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (err) {
    throw new Error(`Cannot read ${root}: ${err.message}`);
  }
  if (!rootStat.isDirectory()) throw new Error(`${root} is not a directory`);

  const skip = new Set(defaultSkips().filter((p) => p !== root));
  const rootDev = crossDevice ? undefined : rootStat.dev;
  const startedAt = Date.now();

  // ---- Phase 1: shallow walk on the main thread to build the skeleton ------
  // One hardlink table for the whole scan, shared with every worker.
  const links = new LinkSet();

  const mainCtx = makeCtx({ minFileSize, rootDev, skip, maxDepth: frontierDepth, links });
  mainCtx.onTick = () =>
    onProgress({ ...totals(mainCtx.counters, []), phase: 'skeleton', queued: 0, done: 0 });

  const tree = walkDir(root, mainCtx);
  tree.n = root; // the root node carries the absolute path
  tree.m = Math.round(rootStat.mtimeMs / 1000);

  const frontier = mainCtx.frontier;

  // ---- Phase 2: workers walk the frontier subtrees -------------------------
  const workerCounters = [];

  if (frontier.length > 0) {
    const nWorkers = Math.max(1, Math.min(concurrency, frontier.length));
    let next = 0;
    let completed = 0;

    await new Promise((resolveAll, rejectAll) => {
      let alive = 0;

      const report = () =>
        onProgress({
          ...totals(mainCtx.counters, workerCounters),
          phase: 'walking',
          queued: frontier.length,
          done: completed,
        });

      for (let w = 0; w < nWorkers; w++) {
        const slot = workerCounters.push({ files: 0, dirs: 0, bytes: 0, errors: 0 }) - 1;

        const worker = new Worker(WORKER_URL, {
          workerData: { minFileSize, rootDev, skip: [...skip], linkBuffer: links.buffer },
        });
        alive++;

        const pump = () => {
          if (next >= frontier.length) {
            worker.postMessage({ type: 'exit' });
            return;
          }
          const i = next++;
          worker.postMessage({ type: 'task', id: i, path: frontier[i].path, name: frontier[i].name });
        };

        worker.on('message', (msg) => {
          if (msg.counters) workerCounters[slot] = msg.counters;

          if (msg.type === 'ready') {
            pump();
            return;
          }
          if (msg.type === 'progress') {
            report();
            return;
          }
          if (msg.type === 'done') {
            // Splice the finished subtree onto the stub already in the skeleton.
            const target = frontier[msg.id].node;
            Object.assign(target, msg.node);
            completed++;
            report();
            pump();
          }
        });

        worker.on('error', rejectAll);
        worker.on('exit', () => {
          alive--;
          if (alive === 0) resolveAll();
        });
      }
    });
  }

  // ---- Phase 3: recompute every directory total from its children ----------
  rollup(tree);

  const c = totals(mainCtx.counters, workerCounters);

  return {
    root: tree,
    stats: {
      rootPath: root,
      // Counts come from rollup(), not the progress counters: workers count
      // only what they walked from the inside, so the frontier stub directories
      // are missing from their tallies.
      files: tree.f,
      dirs: tree.k,
      errors: c.errors,
      sizeOnDisk: tree.s,
      logicalSize: tree.l,
      elapsedMs: Date.now() - startedAt,
      scannedAt: Date.now(),
      minFileSize,
      subtrees: frontier.length,
      disk: diskFree(root),
    },
  };
}

function totals(mainCounters, workerCounters) {
  const out = { ...mainCounters };
  for (const w of workerCounters) {
    out.files += w.files;
    out.dirs += w.dirs;
    out.bytes += w.bytes;
    out.errors += w.errors;
  }
  // Every frontier subtree root is itself a directory the workers counted from
  // the inside, so dirs is close enough for a progress readout; the authoritative
  // count comes from rollup().
  return out;
}

/** Rebuild the absolute path of a node given the chain of names from the root. */
export function joinNames(names) {
  if (!names.length) return sep;
  let out = names[0];
  for (const part of names.slice(1)) {
    if (!out.endsWith(sep)) out += sep;
    out += part;
  }
  return out;
}

export { TYPE_DIR };
