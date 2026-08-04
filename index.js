#!/usr/bin/env node
// onlyfiles — show me what you're hiding down there.
//
// Scans a folder tree in parallel, then serves a local web UI for drilling into
// it folder by folder and file by file, revealing paths in the OS file manager,
// and removing what you decide to remove.
//
// A note on the copy in here: the ambient text is allowed to be a joke, but
// anything the user acts on is not. Byte counts, paths, unit labels, delete
// wording and error messages stay literal — a pun in those costs real clarity.

import { homedir, cpus } from 'node:os';
import { resolve, basename } from 'node:path';
import { createWriteStream } from 'node:fs';
import { createOnlyFilesServer, startScan, newState } from './lib/server.js';
import { openBrowser, fileManagerName } from './lib/fsops.js';
import { REPORTS, formatBytes } from './lib/report.js';

const HELP = `
onlyfiles — see what your disk has been hiding, then deal with it.

USAGE
  onlyfiles [folder] [options]

  With no folder, scans your home directory.

OPTIONS
  -p, --port <n>          Port for the local UI (default 4321, next free if taken)
  -m, --min-file-size <s> Group files smaller than this per folder instead of
                          listing each one. Accepts 64k, 1M, 0. Default 64k.
                          Totals stay exact either way; 0 lists every file but
                          uses much more memory on big trees.
      --report <fmt>      Skip the UI: write a report and exit.
                          fmt is one of ${Object.keys(REPORTS).join(', ')}.
  -o, --out <file>        Where --report writes (default stdout).
      --depth <n>         Max tree depth in the report (default 4 for md, all others full).
  -c, --concurrency <n>   Worker threads (default ${Math.max(1, Math.min(8, cpus().length - 2))} on this machine).
      --cross-device      Also descend into other mounted volumes.
      --read-only         Disable deletion entirely. Reveal and open still work.
      --no-open           Do not launch a browser.
  -h, --help              This text.

EXAMPLES
  onlyfiles                        Scan ~ and open the UI
  onlyfiles / --read-only          Look at the whole boot volume, no deleting
  onlyfiles ~/Library --min-file-size 0
  onlyfiles ~ --report md -o disk.md
  onlyfiles ~ --report csv -o everything.csv

NOTES
  * Sizes are bytes actually occupied on disk, matching \`du\`. Hardlinked files
    are counted once. Symlinks are never followed.
  * Some folders need Full Disk Access on macOS. Without it they are reported as
    unreadable rather than silently counted as empty. Grant it to your terminal
    in System Settings > Privacy & Security > Full Disk Access.
  * Deleting defaults to the Trash, which is recoverable. Permanent deletion is
    a separate, explicitly confirmed action.
  * Reclaim candidates are not all equal. Caches and build output come back on
    the next run; "AI model weights" are just as safe to delete but cost hours of
    bandwidth to fetch again, so they are reported as their own category rather
    than folded in with the free wins.
`;

function parseSize(s) {
  if (s === undefined || s === null || s === '') return null;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i);
  if (!m) throw new Error(`Cannot read size "${s}" — try 0, 64k, 1M`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

function parseArgs(argv) {
  const out = {
    target: null, port: 4321, minFileSize: 64 * 1024, report: null, out: null,
    depth: null, concurrency: undefined, crossDevice: false, readOnly: false, open: true,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': out.help = true; break;
      case '-p': case '--port': out.port = Number(need(i, a)); i++; break;
      case '-m': case '--min-file-size': out.minFileSize = parseSize(need(i, a)); i++; break;
      case '--report': out.report = need(i, a); i++; break;
      case '-o': case '--out': out.out = need(i, a); i++; break;
      case '--depth': out.depth = Number(need(i, a)); i++; break;
      case '-c': case '--concurrency': out.concurrency = Number(need(i, a)); i++; break;
      case '--cross-device': out.crossDevice = true; break;
      case '--read-only': out.readOnly = true; break;
      case '--no-open': out.open = false; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option ${a}  (try --help)`);
        if (out.target) throw new Error('Only one folder can be scanned at a time');
        out.target = a;
    }
  }
  return out;
}

/**
 * Ambient commentary shown while the walk runs. Rotates on a timer so a long
 * scan does not sit on one line for five minutes. Purely decorative: the counts
 * to its right are the part that means anything.
 */
const COMMENTARY = [
  'Having a good look around…',
  'Getting comfortable…',
  'Oh. Oh my.',
  'You have been busy.',
  'Found something big. Not saying where yet.',
  'node_modules. Again.',
  'Still going. There is a lot of you.',
  'Someone has been downloading.',
  'So much of this is called "temp".',
  'Nobody has opened this one in years.',
  'Do not be shy, ~/Library.',
  'Nearly done. Hold still.',
];

const ROTATE_MS = 4000;

/** Progress line on stderr, so stdout stays clean for --report. */
function makeProgressPrinter() {
  const tty = process.stderr.isTTY;
  const startedAt = Date.now();
  let last = 0;
  return {
    update(p) {
      const now = Date.now();
      if (!tty || now - last < 120) return;
      last = now;
      const quip = COMMENTARY[Math.floor((now - startedAt) / ROTATE_MS) % COMMENTARY.length];
      const subtrees = p.queued ? ` · ${p.done}/${p.queued} subtrees` : '';
      const counts =
        `${p.files.toLocaleString()} files · ${p.dirs.toLocaleString()} folders · ` +
        `${formatBytes(p.bytes)}${subtrees}`;
      process.stderr.write(`\r\x1b[2K  ${quip}  ${counts}`);
    },
    done(msg) {
      if (tty) process.stderr.write('\r\x1b[2K');
      if (msg) process.stderr.write(msg + '\n');
    },
  };
}

async function listen(server, preferred) {
  // Try the requested port, then walk upward — a stale tab holding 4321 should
  // not be a fatal error.
  for (let port = preferred; port < preferred + 20; port++) {
    const ok = await new Promise((res) => {
      const onErr = (err) => (err.code === 'EADDRINUSE' ? res(false) : res(Promise.reject(err)));
      server.once('error', onErr);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onErr);
        res(true);
      });
    });
    if (ok) return port;
  }
  throw new Error(`No free port in ${preferred}..${preferred + 19}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`onlyfiles: ${err.message}\n`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const target = resolve(args.target || homedir());
  const state = newState();
  const progress = makeProgressPrinter();

  process.stderr.write(`onlyfiles  ·  let's see what ${target} has been hiding\n`);
  if (args.minFileSize) {
    process.stderr.write(`  (files under ${formatBytes(args.minFileSize)} are grouped per folder; --min-file-size 0 to list all)\n`);
  }

  let stats;
  try {
    ({ stats } = await startScan(state, target, {
      minFileSize: args.minFileSize,
      concurrency: args.concurrency,
      crossDevice: args.crossDevice,
      onProgress: (p) => progress.update(p),
    }));
  } catch (err) {
    progress.done();
    process.stderr.write(`onlyfiles: ${err.message}\n`);
    process.exit(1);
  }

  progress.done(
    `  Seen all of it.  ${stats.files.toLocaleString()} files · ${stats.dirs.toLocaleString()} folders · ` +
    `${formatBytes(stats.sizeOnDisk)} on disk · ${(stats.elapsedMs / 1000).toFixed(1)}s`
  );
  if (stats.errors) {
    process.stderr.write(`  ${stats.errors.toLocaleString()} locations were unreadable (Full Disk Access would include them)\n`);
  }

  // ---- headless report mode ------------------------------------------------
  if (args.report) {
    const spec = REPORTS[args.report];
    if (!spec) {
      process.stderr.write(`onlyfiles: unknown report format "${args.report}" (${Object.keys(REPORTS).join(', ')})\n`);
      process.exit(2);
    }
    const depth = args.depth ?? (args.report === 'md' ? 4 : Infinity);
    const sink = args.out ? createWriteStream(args.out) : process.stdout;
    for (const chunk of spec.gen(state.root, stats, { maxDepth: depth })) {
      if (!sink.write(chunk)) await new Promise((r) => sink.once('drain', r));
    }
    if (args.out) {
      await new Promise((r) => sink.end(r));
      process.stderr.write(`  report written to ${args.out}\n`);
    }
    return;
  }

  // ---- UI mode -------------------------------------------------------------
  const server = createOnlyFilesServer(state, { readOnly: args.readOnly });
  const port = await listen(server, args.port);
  const url = `http://127.0.0.1:${port}/?t=${server.token}`;

  process.stderr.write(`\n  UI:  ${url}\n`);
  process.stderr.write(`  ${args.readOnly ? 'read-only mode — deletion disabled' : `deletes go to the Trash by default · reveal opens ${fileManagerName}`}\n`);
  process.stderr.write('  Ctrl-C to stop.\n\n');

  if (args.open) await openBrowser(url);

  const bye = () => {
    process.stderr.write('\nonlyfiles: stopped.\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main();
