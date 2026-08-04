// The filesystem walker. Strictly read-only: readdir + lstat, nothing else.
// Runs in the main thread (to build a shallow skeleton) and inside worker
// threads (to walk the subtrees hanging off that skeleton).

import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { LinkSet } from './linkset.js';

/**
 * Node wire format. Short keys, because these trees hold hundreds of thousands
 * of entries and get structured-cloned between threads and cached to disk.
 *
 *   n    name (basename only — the full path is rebuilt by walking parents)
 *   t    type: 0 file, 1 directory, 2 symlink
 *   s    size on disk in bytes, recursive for directories
 *   l    logical ("apparent") size in bytes, recursive
 *   f    recursive count of files at or below this node
 *   k    recursive count of directories below this node
 *   m    mtime in whole seconds since the epoch
 *   c    children array — directories only, omitted when empty
 *   x    bit flags, see FLAG_* below
 *   cnt  number of real files a rollup bucket stands for
 */
export const FLAG_UNREADABLE = 1; // directory exists but could not be opened
export const FLAG_ROLLUP = 2; // synthetic "N smaller files" bucket, not a real path
export const FLAG_SKIPPED = 4; // deliberately not descended into

export const TYPE_FILE = 0;
export const TYPE_DIR = 1;
export const TYPE_SYMLINK = 2;

const TICK_EVERY = 4096;

/**
 * Bytes a file actually occupies. `blocks` accounts for sparse files and APFS
 * compression, which is what matters when deciding how much space you would get
 * back. Windows does not report blocks, so fall back to the logical size.
 */
function diskBytes(st) {
  return st.blocks > 0 ? st.blocks * 512 : st.size;
}

function stub(name, flags) {
  const node = { n: name, t: TYPE_DIR, s: 0, l: 0, f: 0, k: 0, m: 0 };
  if (flags) node.x = flags;
  return node;
}

/**
 * Walk `dirPath` and return its node. Never throws for ordinary filesystem
 * problems — unreadable directories come back flagged instead.
 *
 * ctx is built by makeCtx():
 *   minFileSize  files below this size are folded into one synthetic bucket per
 *                directory rather than each getting a node, which cuts the node
 *                count by an order of magnitude without losing any bytes
 *   rootDev      device id of the scan root; other devices are not descended
 *                into, which stops firmlink loops (/System/Volumes/Data) and
 *                keeps external drives out of the totals
 *   skip         Set of absolute paths never to descend into
 *   maxDepth     when set, directories at this depth become frontier entries:
 *                a stub node is inserted and the path is pushed onto
 *                ctx.frontier for a worker to walk instead
 */
export function walkDir(dirPath, ctx, depth = 0) {
  const node = stub(dirPath);

  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    ctx.counters.errors++;
    node.x = FLAG_UNREADABLE;
    return node;
  }

  const children = [];
  let rollupBytes = 0;
  let rollupLogical = 0;
  let rollupCount = 0;

  for (const entry of entries) {
    const name = entry.name;
    const full = join(dirPath, name);

    // Symlinks count as their own small entry and are never followed: following
    // them would double-count targets and can loop forever.
    if (entry.isSymbolicLink()) {
      let st;
      try {
        st = lstatSync(full);
      } catch {
        ctx.counters.errors++;
        continue;
      }
      children.push({
        n: name, t: TYPE_SYMLINK, s: diskBytes(st), l: st.size, f: 0, k: 0,
        m: Math.round(st.mtimeMs / 1000),
      });
      ctx.counters.files++;
      continue;
    }

    if (entry.isDirectory()) {
      if (ctx.skip.has(full)) {
        children.push(stub(name, FLAG_SKIPPED));
        continue;
      }

      let st;
      try {
        st = lstatSync(full);
      } catch {
        ctx.counters.errors++;
        children.push(stub(name, FLAG_UNREADABLE));
        continue;
      }

      // Refuse to cross onto a different filesystem.
      if (ctx.rootDev !== undefined && st.dev !== ctx.rootDev) {
        children.push(stub(name, FLAG_SKIPPED));
        continue;
      }

      const mtime = Math.round(st.mtimeMs / 1000);

      // Hand deep subtrees to the worker pool instead of walking them here.
      if (ctx.maxDepth !== undefined && depth + 1 >= ctx.maxDepth) {
        const s = stub(name);
        s.m = mtime;
        ctx.frontier.push({ path: full, name, node: s });
        children.push(s);
        continue;
      }

      ctx.counters.dirs++;
      const child = walkDir(full, ctx, depth + 1);
      child.n = name; // walkDir seeds n with the full path; keep the basename
      child.m = mtime;
      children.push(child);
      continue;
    }

    // Regular file, or something exotic (socket, fifo) — treated as a file.
    let st;
    try {
      st = lstatSync(full);
    } catch {
      ctx.counters.errors++;
      continue;
    }

    let sz = diskBytes(st);

    // A hardlinked file's bytes are counted the first time we meet the inode
    // only, so a file with 5 links does not look like 5x the space. This is the
    // same accounting `du` does. The table is shared across all threads, so the
    // total is exact and reproducible however the work was scheduled.
    if (st.nlink > 1 && !ctx.links.add(st.ino)) sz = 0;

    ctx.counters.files++;
    ctx.counters.bytes += sz;

    if (sz < ctx.minFileSize) {
      rollupBytes += sz;
      rollupLogical += st.size;
      rollupCount++;
    } else {
      children.push({
        n: name, t: TYPE_FILE, s: sz, l: st.size, f: 0, k: 0,
        m: Math.round(st.mtimeMs / 1000),
      });
    }

    if ((ctx.counters.files & (TICK_EVERY - 1)) === 0) ctx.onTick?.();
  }

  if (rollupCount > 0) {
    children.push({
      n: `${rollupCount.toLocaleString()} smaller file${rollupCount === 1 ? '' : 's'}`,
      t: TYPE_FILE, s: rollupBytes, l: rollupLogical, f: 0, k: 0, m: 0,
      x: FLAG_ROLLUP, cnt: rollupCount,
    });
  }

  if (children.length) node.c = children;
  return node;
}

/** Build the mutable context shared by one walk. */
export function makeCtx({ minFileSize = 0, rootDev, skip = new Set(), maxDepth, onTick, links } = {}) {
  return {
    minFileSize,
    rootDev,
    skip,
    maxDepth,
    onTick,
    links: links || new LinkSet(),
    frontier: [],
    counters: { files: 0, dirs: 0, bytes: 0, errors: 0 },
  };
}

/**
 * Recompute every directory's recursive totals from its children, bottom-up.
 *
 * The main thread splices worker results into stub nodes after the fact, so
 * sizes accumulated during the walk would be stale. Recomputing here is a pure
 * in-memory pass and keeps one single definition of how totals are derived.
 * Iterative rather than recursive so a pathologically deep tree can't blow the
 * stack.
 */
export function rollup(root) {
  const order = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.t !== TYPE_DIR || !n.c) continue;
    order.push(n);
    for (const c of n.c) if (c.t === TYPE_DIR && c.c) stack.push(c);
  }
  // Deepest directories first, so children are final before their parent sums.
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    let s = 0, l = 0, f = 0, k = 0, nm = n.m || 0;
    for (const c of n.c) {
      s += c.s;
      l += c.l;
      if (c.t === TYPE_DIR) {
        f += c.f;
        k += c.k + 1;
        if (c.nm > nm) nm = c.nm;
      } else {
        f += c.cnt || 1;
        if (c.m > nm) nm = c.m;
      }
    }
    n.s = s;
    n.l = l;
    n.f = f;
    n.k = k;
    // Newest mtime anywhere in the subtree. A directory's own mtime only moves
    // when its direct entries change, so a folder full of stale subfolders can
    // look freshly touched (and vice versa). This is what "untouched for a
    // year" has to be measured against.
    n.nm = nm;
  }
  return root;
}
