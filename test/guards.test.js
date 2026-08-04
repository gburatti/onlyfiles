// Tests for the deletion guards and the size accounting.
//
// Nothing in this file deletes anything. assertDeletable() only validates a path
// and lstats it; deletePath() is never called here on purpose. The point is to
// prove the guards reject what they should *before* any removal is attempted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';
import { assertDeletable, UnsafePathError } from '../lib/fsops.js';
import { LinkSet } from '../lib/linkset.js';
import { scan } from '../lib/scanner.js';
import { findNode, detachPath, largestFiles, suspects } from '../lib/tree.js';
import { formatBytes } from '../lib/report.js';

/** A throwaway tree to point the guards at. Created, never removed by us. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'onlyfiles-test-'));
  mkdirSync(join(root, 'project', 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(join(root, 'project', 'src'), { recursive: true });
  writeFileSync(join(root, 'project', 'src', 'index.js'), 'x'.repeat(4096));
  writeFileSync(join(root, 'project', 'node_modules', 'left-pad', 'index.js'), 'y'.repeat(2048));
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(300 * 1024));
  return root;
}

test('assertDeletable refuses the scan root itself', () => {
  const root = fixture();
  assert.throws(() => assertDeletable(root, root), UnsafePathError);
});

test('assertDeletable refuses paths outside the scan root', () => {
  const root = fixture();
  assert.throws(() => assertDeletable('/etc/hosts', root), UnsafePathError);
  assert.throws(() => assertDeletable(homedir(), root), UnsafePathError);
});

test('assertDeletable refuses ../ escapes', () => {
  const root = fixture();
  assert.throws(() => assertDeletable(join(root, '..', '..', 'etc'), root), UnsafePathError);
  assert.throws(() => assertDeletable(`${root}/project/../../../tmp`, root), UnsafePathError);
});

test('assertDeletable is not fooled by a sibling with the root as a name prefix', () => {
  // "/tmp/x" must not appear to contain "/tmp/xyz".
  const root = mkdtempSync(join(tmpdir(), 'ds-prefix-'));
  const sibling = root + 'zzz';
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'f'), 'a');
  assert.throws(() => assertDeletable(join(sibling, 'f'), root), UnsafePathError);
});

test('assertDeletable refuses protected locations even when inside the root', () => {
  // Scanning / would put ~/Library inside the root; it must still be refused.
  assert.throws(() => assertDeletable(homedir(), '/'), UnsafePathError);
  assert.throws(() => assertDeletable(join(homedir(), 'Library'), '/'), UnsafePathError);
  assert.throws(() => assertDeletable('/System', '/'), UnsafePathError);
  assert.throws(() => assertDeletable('/Users', '/'), UnsafePathError);
});

test('assertDeletable allows a child of a protected folder', () => {
  // ~/Library is protected but ~/Library/Caches must stay removable.
  const p = join(homedir(), 'Library', 'Caches');
  try {
    assert.equal(assertDeletable(p, homedir()), p);
  } catch (err) {
    // Fine if this machine has no ~/Library/Caches; only a guard bug matters.
    assert.match(err.message, /does not exist/);
  }
});

test('assertDeletable refuses a path that does not exist', () => {
  const root = fixture();
  assert.throws(() => assertDeletable(join(root, 'nope'), root), UnsafePathError);
});

test('assertDeletable refuses everything in read-only mode', () => {
  const root = fixture();
  assert.throws(
    () => assertDeletable(join(root, 'big.bin'), root, { readOnly: true }),
    /read-only/,
  );
});

test('assertDeletable accepts a legitimate target', () => {
  const root = fixture();
  const target = join(root, 'project', 'node_modules');
  assert.equal(assertDeletable(target, root), target);
});

test('LinkSet counts each inode exactly once', () => {
  const s = new LinkSet(1 << 12);
  assert.equal(s.add(42), true);
  assert.equal(s.add(42), false);
  assert.equal(s.add(43), true);
  assert.equal(s.add(43), false);
});

test('LinkSet is shareable across views onto the same buffer', () => {
  const a = new LinkSet(1 << 12);
  const b = LinkSet.fromBuffer(a.buffer);
  assert.equal(a.add(7), true);
  assert.equal(b.add(7), false, 'the second view must see the first view\'s claim');
});

test('scan totals are identical regardless of worker count', async () => {
  const root = fixture();
  const one = await scan(root, { concurrency: 1, frontierDepth: 2 });
  const many = await scan(root, { concurrency: 8, frontierDepth: 2 });
  assert.equal(one.stats.sizeOnDisk, many.stats.sizeOnDisk);
  assert.equal(one.stats.files, many.stats.files);
  assert.equal(one.stats.dirs, many.stats.dirs);
});

test('minFileSize changes the node count but never the byte total', async () => {
  const root = fixture();
  const all = await scan(root, { minFileSize: 0 });
  const grouped = await scan(root, { minFileSize: 64 * 1024 });
  assert.equal(all.stats.sizeOnDisk, grouped.stats.sizeOnDisk);
  assert.equal(all.stats.files, grouped.stats.files);
});

test('rollup makes every directory equal the sum of its children', async () => {
  const root = fixture();
  const { root: tree } = await scan(root, { minFileSize: 0 });
  const check = (n) => {
    if (!n.c) return;
    const sum = n.c.reduce((a, c) => a + c.s, 0);
    assert.equal(n.s, sum, `size mismatch at ${n.n}`);
    n.c.forEach(check);
  };
  check(tree);
});

test('findNode resolves nested paths and rejects strangers', async () => {
  const root = fixture();
  const { root: tree } = await scan(root);
  assert.ok(findNode(tree, join(root, 'project', 'src')));
  assert.equal(findNode(tree, '/etc/hosts'), null);
  assert.equal(findNode(tree, join(root, 'ghost')), null);
});

test('detachPath subtracts the removed bytes from every ancestor', async () => {
  const root = fixture();
  const { root: tree } = await scan(root, { minFileSize: 0 });
  const before = tree.s;
  const nm = findNode(tree, join(root, 'project', 'node_modules'));
  assert.ok(nm, 'fixture should contain node_modules');
  const size = nm.s;

  // Tree bookkeeping only — the directory itself is left on disk.
  assert.equal(detachPath(tree, join(root, 'project', 'node_modules')), true);
  assert.equal(tree.s, before - size);
  assert.equal(findNode(tree, join(root, 'project', 'node_modules')), null);
});

test('suspects finds node_modules and does not descend into it', async () => {
  const root = fixture();
  const { root: tree } = await scan(root);
  const nm = suspects(tree).find((s) => s.category === 'node_modules');
  assert.ok(nm, 'node_modules should be reported');
  assert.equal(nm.count, 1, 'the nested package must not be counted separately');
});

test('largestFiles skips the synthetic rollup buckets', async () => {
  const root = fixture();
  const { root: tree } = await scan(root, { minFileSize: 64 * 1024 });
  for (const f of largestFiles(tree, 20)) {
    assert.ok(f.path, 'every reported file must have a real path');
    assert.doesNotMatch(f.name, /smaller files?$/);
  }
});

test('formatBytes uses base-1024 with matching IEC labels', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(1536), '1.50 KiB');
  assert.equal(formatBytes(1024 ** 3 * 4.3), '4.30 GiB');
  // Binary maths must be labelled binary: calling 1024^3 a "GB" is what makes a
  // tool disagree with Finder about the size of the same disk.
  assert.equal(formatBytes(494384795648), '460 GiB');
});
