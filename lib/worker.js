// Worker thread: pulls directory subtrees off the main thread's queue and walks
// each one to completion. Read-only — a worker never modifies the filesystem.

import { parentPort, workerData } from 'node:worker_threads';
import { walkDir, makeCtx } from './walk.js';
import { LinkSet } from './linkset.js';

const { minFileSize, rootDev, skip, linkBuffer } = workerData;

// One context per worker so counters persist across the several subtrees this
// worker handles. The hardlink table, by contrast, is shared with every other
// thread so each inode's bytes are counted exactly once overall.
const ctx = makeCtx({
  minFileSize,
  rootDev,
  skip: new Set(skip),
  links: LinkSet.fromBuffer(linkBuffer),
  onTick: () => post('progress'),
});

let lastPost = 0;

function post(type, extra) {
  parentPort.postMessage({
    type,
    counters: { ...ctx.counters },
    ...extra,
  });
}

parentPort.on('message', (msg) => {
  if (msg.type === 'exit') {
    process.exit(0);
  }

  if (msg.type === 'task') {
    let node = null;
    try {
      node = walkDir(msg.path, ctx);
      node.n = msg.name;
    } catch (err) {
      // Never let one bad subtree take down the scan.
      node = {
        n: msg.name, t: 1, s: 0, l: 0, f: 0, k: 0, m: 0, x: 1,
        err: String(err && err.message ? err.message : err),
      };
    }
    post('done', { id: msg.id, node });
  }
});

// Throttle: walkDir's onTick fires every 4096 files, which is already coarse,
// but on fast warm caches that is still a lot of messages.
const origTick = ctx.onTick;
ctx.onTick = () => {
  const now = Date.now();
  if (now - lastPost < 100) return;
  lastPost = now;
  origTick();
};

post('ready');
