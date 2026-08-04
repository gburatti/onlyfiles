// Queries over a scanned tree. Everything here is pure and read-only.
//
// Nodes deliberately carry no parent pointers (that would be one extra slot on
// every one of a few hundred thousand objects), so each traversal threads the
// absolute path down as it descends.

import { join, sep, basename } from 'node:path';
import { TYPE_DIR, TYPE_FILE, TYPE_SYMLINK, FLAG_ROLLUP, FLAG_UNREADABLE, FLAG_SKIPPED } from './walk.js';

/** A bounded min-heap, so "top N of two million" never sorts two million. */
class TopN {
  constructor(limit, score) {
    this.limit = limit;
    this.score = score;
    this.heap = [];
  }
  get threshold() {
    return this.heap.length < this.limit ? -Infinity : this.score(this.heap[0]);
  }
  push(item) {
    const s = this.score(item);
    if (this.heap.length < this.limit) {
      this.heap.push(item);
      this.#up(this.heap.length - 1);
    } else if (s > this.score(this.heap[0])) {
      this.heap[0] = item;
      this.#down(0);
    }
  }
  result() {
    return [...this.heap].sort((a, b) => this.score(b) - this.score(a));
  }
  #up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.score(this.heap[p]) <= this.score(this.heap[i])) break;
      [this.heap[p], this.heap[i]] = [this.heap[i], this.heap[p]];
      i = p;
    }
  }
  #down(i) {
    const n = this.heap.length;
    for (;;) {
      let m = i;
      const l = 2 * i + 1, r = l + 1;
      if (l < n && this.score(this.heap[l]) < this.score(this.heap[m])) m = l;
      if (r < n && this.score(this.heap[r]) < this.score(this.heap[m])) m = r;
      if (m === i) break;
      [this.heap[m], this.heap[i]] = [this.heap[i], this.heap[m]];
      i = m;
    }
  }
}

/** True for synthetic nodes that do not correspond to a real filesystem path. */
export function isSynthetic(node) {
  return ((node.x || 0) & FLAG_ROLLUP) !== 0;
}

/**
 * Walk every node, calling body(node, absolutePath, parent).
 * Iterative, so depth cannot overflow the stack.
 */
export function walkNodes(root, body) {
  const stack = [[root, root.n, null]];
  while (stack.length) {
    const [node, path, parent] = stack.pop();
    body(node, path, parent);
    if (node.c) {
      for (const child of node.c) {
        stack.push([child, isSynthetic(child) ? path : join(path, child.n), node]);
      }
    }
  }
}

/** Resolve an absolute path to its node, or null. O(depth × siblings). */
export function findNode(root, absPath) {
  const rootPath = root.n;
  if (absPath === rootPath) return root;
  if (!absPath.startsWith(rootPath)) return null;

  let rest = absPath.slice(rootPath.length);
  if (rest.startsWith(sep)) rest = rest.slice(1);
  if (!rest) return root;

  let node = root;
  for (const part of rest.split(sep)) {
    if (!node.c) return null;
    const next = node.c.find((c) => c.n === part && !isSynthetic(c));
    if (!next) return null;
    node = next;
  }
  return node;
}

/**
 * Direct children of a directory, biggest first, shaped for the UI.
 * `offset`/`limit` keep a 40k-entry node_modules from being sent in one go.
 */
export function children(root, absPath, { offset = 0, limit = 500 } = {}) {
  const node = findNode(root, absPath);
  if (!node) return null;
  if (node.t !== TYPE_DIR) return { path: absPath, total: 0, items: [] };

  const all = [...(node.c || [])].sort((a, b) => b.s - a.s);
  const items = all.slice(offset, offset + limit).map((c) => shape(c, absPath, node.s));

  return {
    path: absPath,
    total: all.length,
    offset,
    truncated: offset + items.length < all.length,
    parentSize: node.s,
    items,
  };
}

/** Convert an internal node into the JSON the browser consumes. */
export function shape(node, parentPath, parentSize = 0) {
  const synthetic = isSynthetic(node);
  const flags = node.x || 0;
  return {
    name: node.n,
    path: synthetic ? null : join(parentPath, node.n),
    size: node.s,
    logical: node.l,
    isDir: node.t === TYPE_DIR,
    isSymlink: node.t === TYPE_SYMLINK,
    files: node.f,
    dirs: node.k,
    mtime: node.m,
    hasChildren: !!(node.c && node.c.length),
    synthetic,
    count: node.cnt || 0,
    unreadable: (flags & FLAG_UNREADABLE) !== 0,
    skipped: (flags & FLAG_SKIPPED) !== 0,
    pctOfParent: parentSize > 0 ? node.s / parentSize : 0,
  };
}

/** The N largest individual files anywhere under the root. */
export function largestFiles(root, limit = 200) {
  const top = new TopN(limit, (x) => x.size);
  walkNodes(root, (node, path) => {
    if (node.t === TYPE_DIR || isSynthetic(node)) return;
    if (node.s <= top.threshold) return;
    top.push({ name: node.n, path, size: node.s, logical: node.l, mtime: node.m, isSymlink: node.t === TYPE_SYMLINK });
  });
  return top.result();
}

/**
 * The N largest directories, measured by the bytes held *directly* in them
 * rather than recursively. Ranking by recursive size just lists the root's
 * ancestors; "own bytes" surfaces the folder actually holding the data.
 */
export function largestDirs(root, limit = 200) {
  const top = new TopN(limit, (x) => x.ownSize);
  walkNodes(root, (node, path) => {
    if (node.t !== TYPE_DIR || !node.c) return;
    let own = 0;
    for (const c of node.c) if (c.t !== TYPE_DIR) own += c.s;
    if (own <= top.threshold) return;
    top.push({ name: node.n === root.n ? root.n : node.n, path, size: node.s, ownSize: own, files: node.f, dirs: node.k, mtime: node.m });
  });
  return top.result();
}

/** Aggregate every file by extension. */
export function byExtension(root, limit = 60) {
  const map = new Map();
  walkNodes(root, (node) => {
    if (node.t === TYPE_DIR) return;
    let ext;
    if (isSynthetic(node)) {
      ext = '(small files)';
    } else {
      const dot = node.n.lastIndexOf('.');
      ext = dot > 0 ? node.n.slice(dot + 1).toLowerCase() : '(no extension)';
      if (ext.length > 16) ext = '(no extension)';
    }
    const cur = map.get(ext) || { ext, size: 0, count: 0 };
    cur.size += node.s;
    cur.count += node.cnt || 1;
    map.set(ext, cur);
  });
  return [...map.values()].sort((a, b) => b.size - a.size).slice(0, limit);
}

/**
 * Caches and build artefacts: the folders that are usually safe to remove
 * because a tool will simply regenerate them. Grouped by category so a hundred
 * scattered node_modules show up as one line with a total.
 *
 * Nothing here is deleted or even touched — this is a reporting view. The user
 * decides what goes.
 */
const SUSPECT_RULES = [
  { cat: 'node_modules', why: 'Reinstallable with npm/pnpm/yarn install', dirs: ['node_modules'] },
  { cat: 'Build output', why: 'Regenerated by your build command', dirs: ['dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', 'target'] },
  { cat: 'Bundler / tool caches', why: 'Regenerated on next run', dirs: ['.turbo', '.parcel-cache', '.vite', '.webpack', '.eslintcache', '.dart_tool'] },
  // Deliberately NOT a blanket `.cache` rule. ~/.cache is a shared dumping
  // ground: some of it is a build cache worth nothing, and some of it is tens of
  // gigabytes of model weights that cost hours of bandwidth to fetch again.
  // Matching the parent would both hide that distinction and stop the walk
  // before it could report the subfolders separately, so each is listed on its
  // own with an honest description of what deleting it actually costs.
  {
    cat: 'AI model weights',
    why: 'Free to delete, but slow and bandwidth-heavy to download again',
    paths: [
      '.cache/huggingface', '.cache/torch', '.cache/whisper', '.cache/lm-studio',
      '.ollama/models', '.diffusionbee', '.lmstudio', '.cache/gpt4all',
      'Library/Application Support/nomic.ai',
    ],
  },
  { cat: 'Python envs & caches', why: 'Recreatable from requirements/lockfile', dirs: ['.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox'] },
  { cat: 'Xcode', why: 'Xcode rebuilds these; DeviceSupport re-downloads', paths: ['Library/Developer/Xcode/DerivedData', 'Library/Developer/Xcode/iOS DeviceSupport', 'Library/Developer/Xcode/watchOS DeviceSupport', 'Library/Developer/CoreSimulator/Caches', 'Library/Developer/CoreSimulator/Devices'] },
  { cat: 'Package manager caches', why: 'Re-downloaded on demand', paths: ['.npm/_cacache', '.pnpm-store', 'Library/pnpm/store', '.yarn/cache', '.bun/install/cache', 'Library/Caches/Homebrew', '.cargo/registry', '.rustup/toolchains', 'go/pkg/mod', '.m2/repository', '.cocoapods', 'Library/Caches/pip', '.gradle/caches'] },
  { cat: 'Containers / VMs', why: 'Docker & VM disk images — prune from the app', paths: ['Library/Containers/com.docker.docker', '.docker', '.orbstack', '.colima', 'Library/Application Support/Lima'] },
  { cat: 'App caches', why: 'Apps regenerate these', paths: ['Library/Caches'] },
  { cat: 'Trash', why: 'Already deleted — emptying reclaims the space', paths: ['.Trash'] },
  { cat: 'iOS backups', why: 'Device backups; often several stale copies', paths: ['Library/Application Support/MobileSync/Backup'] },
];

export function suspects(root) {
  const byCat = new Map();
  const dirRules = new Map();
  for (const r of SUSPECT_RULES) for (const d of r.dirs || []) dirRules.set(d, r);

  const pathRules = [];
  for (const r of SUSPECT_RULES) for (const p of r.paths || []) pathRules.push([p, r]);

  const add = (rule, node, path) => {
    let e = byCat.get(rule.cat);
    if (!e) {
      e = { category: rule.cat, why: rule.why, size: 0, count: 0, items: [] };
      byCat.set(rule.cat, e);
    }
    e.size += node.s;
    e.count++;
    e.items.push({ path, size: node.s, files: node.f, mtime: node.m });
  };

  // Explicit stack so a matched folder can be reported without descending into
  // it — otherwise a node_modules nested inside another would be counted twice.
  const stack = [[root, root.n]];
  while (stack.length) {
    const [node, path] = stack.pop();
    if (node.t !== TYPE_DIR) continue;

    const byName = dirRules.get(node.n);
    let matched = byName && node !== root ? byName : null;

    if (!matched) {
      for (const [suffix, rule] of pathRules) {
        if (path.endsWith(sep + suffix.split('/').join(sep))) { matched = rule; break; }
      }
    }

    if (matched) {
      add(matched, node, path);
      continue; // report the whole folder, don't double-count what's inside
    }

    if (node.c) for (const c of node.c) if (c.t === TYPE_DIR) stack.push([c, join(path, c.n)]);
  }

  for (const e of byCat.values()) {
    e.items.sort((a, b) => b.size - a.size);
    e.items = e.items.slice(0, 200);
  }
  return [...byCat.values()].sort((a, b) => b.size - a.size);
}

/** Substring search over names, biggest matches first. */
export function search(root, query, limit = 300) {
  const q = query.toLowerCase();
  if (!q) return [];
  const top = new TopN(limit, (x) => x.size);
  walkNodes(root, (node, path) => {
    if (isSynthetic(node)) return;
    if (!node.n.toLowerCase().includes(q)) return;
    if (node.s <= top.threshold) return;
    top.push({ name: node.n, path, size: node.s, isDir: node.t === TYPE_DIR, files: node.f, mtime: node.m });
  });
  return top.result();
}

/**
 * Directories holding a lot of data where *nothing in the subtree* has been
 * modified recently. Judged on the recursive newest-mtime computed by rollup(),
 * not the folder's own mtime, which would flag a project whose files are all
 * current simply because its top-level listing has not changed.
 */
export function staleDirs(root, { olderThanDays = 365, limit = 100, minSize = 50 * 1024 * 1024 } = {}) {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const top = new TopN(limit, (x) => x.size);
  walkNodes(root, (node, path) => {
    if (node.t !== TYPE_DIR) return;
    const newest = node.nm || node.m;
    if (!newest || newest > cutoff) return;
    if (node.s < minSize || node.s <= top.threshold) return;
    top.push({ name: node.n, path, size: node.s, files: node.f, mtime: newest });
  });
  return top.result();
}

/**
 * A parent whose whole subtree is stale reports as stale, and so does every
 * folder inside it. Keep only the outermost ones so the view is a list of
 * decisions rather than the same decision at eight depths.
 */
export function shallowest(items) {
  const sorted = [...items].sort((a, b) => a.path.length - b.path.length);
  const kept = [];
  for (const it of sorted) {
    if (!kept.some((k) => it.path.startsWith(k.path + sep))) kept.push(it);
  }
  return kept.sort((a, b) => b.size - a.size);
}

/**
 * Subtract a removed subtree's bytes from its ancestors and detach it, so the
 * UI reflects a deletion without paying for a whole rescan.
 */
export function detachPath(root, absPath) {
  const rootPath = root.n;
  if (absPath === rootPath || !absPath.startsWith(rootPath)) return false;

  let rest = absPath.slice(rootPath.length);
  if (rest.startsWith(sep)) rest = rest.slice(1);
  const parts = rest.split(sep);

  const chain = [root];
  let node = root;
  for (const part of parts) {
    if (!node.c) return false;
    const next = node.c.find((c) => c.n === part && !isSynthetic(c));
    if (!next) return false;
    chain.push(next);
    node = next;
  }

  const removed = chain.pop();
  const parent = chain[chain.length - 1];
  parent.c = parent.c.filter((c) => c !== removed);

  const files = removed.t === TYPE_DIR ? removed.f : 1;
  const dirs = removed.t === TYPE_DIR ? removed.k + 1 : 0;
  for (const anc of chain) {
    anc.s -= removed.s;
    anc.l -= removed.l;
    anc.f -= files;
    anc.k -= dirs;
  }
  return true;
}

export { TYPE_DIR, TYPE_FILE, TYPE_SYMLINK };
