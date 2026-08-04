// Report generation: the "everything that's in there, folder by folder, file by
// file" artefact.
//
// These are generators yielding chunks so the HTTP layer can stream them. A CSV
// of a full home directory is a few hundred megabytes of text; building that as
// one string first would be a bad time.

import { join } from 'node:path';
import { TYPE_DIR } from './walk.js';
import { isSynthetic, largestFiles, byExtension, suspects, largestDirs } from './tree.js';

/**
 * Base-1024 with the matching IEC labels. The whole tool is verified against
 * `du`, which divides by 1024, so the arithmetic stays binary — but calling
 * 1024^3 a "GB" is what makes a tool report 460 GB for the volume Finder calls
 * 494 GB. Saying GiB keeps the numbers and removes the ambiguity.
 */
export function formatBytes(bytes, pad = false) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let n = Math.abs(bytes);
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const dp = u === 0 ? 0 : n < 10 ? 2 : n < 100 ? 1 : 0;
  const s = `${bytes < 0 ? '-' : ''}${n.toFixed(dp)} ${units[u]}`;
  return pad ? s.padStart(10) : s;
}

function isoDate(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Depth-first, children biggest-first — the order you actually want to read a
 * disk report in. Yields [node, absolutePath, depth].
 */
function* preorder(root, maxDepth = Infinity) {
  const stack = [[root, root.n, 0]];
  while (stack.length) {
    const frame = stack.pop();
    yield frame;
    const [node, path, depth] = frame;
    if (depth >= maxDepth || !node.c) continue;
    // Pushed in ascending order so the largest pops first.
    const kids = [...node.c].sort((a, b) => a.s - b.s);
    for (const c of kids) {
      stack.push([c, isSynthetic(c) ? path : join(path, c.n), depth + 1]);
    }
  }
}

/** Flat CSV: one row per node. */
export function* csvReport(root, stats, { maxDepth = Infinity } = {}) {
  yield 'path,name,type,size_on_disk_bytes,size_on_disk_human,logical_bytes,files,dirs,modified\n';
  for (const [node, path, depth] of preorder(root, maxDepth)) {
    const type = node.t === TYPE_DIR ? 'dir' : node.t === 2 ? 'symlink' : isSynthetic(node) ? 'rollup' : 'file';
    yield [
      csvCell(isSynthetic(node) ? `${path}/*` : path),
      csvCell(node.n),
      type,
      node.s,
      csvCell(formatBytes(node.s)),
      node.l,
      node.t === TYPE_DIR ? node.f : node.cnt || 1,
      node.t === TYPE_DIR ? node.k : 0,
      isoDate(node.m),
    ].join(',') + '\n';
    if (depth === 0) continue;
  }
}

/** Indented plain-text tree, closest to what `du` output feels like. */
export function* treeReport(root, stats, { maxDepth = Infinity } = {}) {
  yield header(stats).map((l) => `${l}\n`).join('');
  yield '\n';
  for (const [node, path, depth] of preorder(root, maxDepth)) {
    const indent = '  '.repeat(depth);
    const name = depth === 0 ? path : node.n + (node.t === TYPE_DIR ? '/' : '');
    const pct = node.s && root.s ? ` ${((node.s / root.s) * 100).toFixed(1).padStart(5)}%` : '      ';
    yield `${formatBytes(node.s, true)}${pct}  ${indent}${name}\n`;
  }
}

/** Markdown report: summary, biggest offenders, reclaim candidates, then tree. */
export function* markdownReport(root, stats, { maxDepth = 4 } = {}) {
  yield `# Disk report — \`${stats.rootPath}\`\n\n`;
  for (const line of header(stats)) yield `- ${line}\n`;

  if (stats.disk) {
    const { total, used, free } = stats.disk;
    yield `- Volume: ${formatBytes(used)} used of ${formatBytes(total)}, ${formatBytes(free)} free`;
    yield ` (${((used / total) * 100).toFixed(1)}% full)\n`;
  }

  yield '\n## Reclaim candidates\n\n';
  yield 'Caches, build output and other regenerable data. Nothing here has been touched —\n';
  yield 'read the last column before removing anything, since the cost of getting it back varies.\n\n';
  yield '| Category | Size | Folders | Why it is a candidate |\n|---|---:|---:|---|\n';
  const sus = suspects(root);
  for (const s of sus) {
    yield `| ${s.category} | ${formatBytes(s.size)} | ${s.count} | ${s.why} |\n`;
  }
  if (!sus.length) yield '| _none found_ | | | |\n';

  const reclaimable = sus.reduce((a, s) => a + s.size, 0);
  yield `\n**Total in reclaim candidates: ${formatBytes(reclaimable)}**\n`;

  yield '\n## 50 largest files\n\n| Size | Modified | Path |\n|---:|---|---|\n';
  for (const f of largestFiles(root, 50)) {
    yield `| ${formatBytes(f.size)} | ${isoDate(f.mtime)} | \`${f.path}\` |\n`;
  }

  yield '\n## 30 folders holding the most data directly\n\n';
  yield 'Ranked by bytes held in the folder itself, not by its subtree.\n\n';
  yield '| Own size | Subtree | Path |\n|---:|---:|---|\n';
  for (const d of largestDirs(root, 30)) {
    yield `| ${formatBytes(d.ownSize)} | ${formatBytes(d.size)} | \`${d.path}\` |\n`;
  }

  yield '\n## By file type\n\n| Extension | Size | Files |\n|---:|---:|---:|\n';
  for (const e of byExtension(root, 30)) {
    yield `| ${e.ext} | ${formatBytes(e.size)} | ${e.count.toLocaleString()} |\n`;
  }

  yield `\n## Folder tree (depth ${maxDepth})\n\n\`\`\`\n`;
  for (const [node, path, depth] of preorder(root, maxDepth)) {
    const indent = '  '.repeat(depth);
    const name = depth === 0 ? path : node.n + (node.t === TYPE_DIR ? '/' : '');
    yield `${formatBytes(node.s, true)}  ${indent}${name}\n`;
  }
  yield '```\n';
}

/** Streaming JSON so the whole tree never has to be one string. */
export function* jsonReport(root, stats) {
  yield `{"stats":${JSON.stringify(stats)},"tree":`;
  yield* jsonNode(root, root.n);
  yield '}';
}

function* jsonNode(node, path) {
  const base = {
    name: node.n,
    path: isSynthetic(node) ? null : path,
    type: node.t === TYPE_DIR ? 'dir' : node.t === 2 ? 'symlink' : isSynthetic(node) ? 'rollup' : 'file',
    sizeOnDisk: node.s,
    logicalSize: node.l,
    files: node.t === TYPE_DIR ? node.f : node.cnt || 1,
    dirs: node.t === TYPE_DIR ? node.k : 0,
    modified: node.m ? new Date(node.m * 1000).toISOString() : null,
  };
  const head = JSON.stringify(base);
  if (!node.c || !node.c.length) {
    yield head;
    return;
  }
  yield `${head.slice(0, -1)},"children":[`;
  const kids = [...node.c].sort((a, b) => b.s - a.s);
  for (let i = 0; i < kids.length; i++) {
    if (i) yield ',';
    const c = kids[i];
    yield* jsonNode(c, isSynthetic(c) ? path : join(path, c.n));
  }
  yield ']}';
}

function header(stats) {
  const lines = [
    `Scanned: ${stats.rootPath}`,
    `Total size on disk: ${formatBytes(stats.sizeOnDisk)} (${stats.sizeOnDisk.toLocaleString()} bytes)`,
    `Logical size: ${formatBytes(stats.logicalSize)}`,
    `Files: ${stats.files.toLocaleString()}  Folders: ${stats.dirs.toLocaleString()}`,
    `Scan took: ${(stats.elapsedMs / 1000).toFixed(1)}s`,
    `Generated: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
  ];
  if (stats.errors) {
    lines.push(`Unreadable locations: ${stats.errors} (grant Full Disk Access to include them)`);
  }
  if (stats.minFileSize) {
    lines.push(`Files under ${formatBytes(stats.minFileSize)} are grouped per folder rather than listed individually`);
  }
  return lines;
}

export const REPORTS = {
  md: { gen: markdownReport, mime: 'text/markdown; charset=utf-8', ext: 'md' },
  csv: { gen: csvReport, mime: 'text/csv; charset=utf-8', ext: 'csv' },
  txt: { gen: treeReport, mime: 'text/plain; charset=utf-8', ext: 'txt' },
  json: { gen: jsonReport, mime: 'application/json; charset=utf-8', ext: 'json' },
};
