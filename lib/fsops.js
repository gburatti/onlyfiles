// Filesystem side effects: reveal, open, and delete.
//
// Everything destructive funnels through assertDeletable() first. The guards are
// deliberately paranoid — this tool exists to be pointed at a home directory and
// then clicked around in, which is exactly the situation where one bad path
// string ruins someone's week.

import { spawn } from 'node:child_process';
import { rmSync, lstatSync } from 'node:fs';
import { resolve, normalize, sep, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import trash from 'trash';

const PLATFORM = platform();
const HOME = homedir();

/**
 * Paths that may never be deleted, matched exactly. Children of these are fine
 * — removing ~/Library/Caches must stay possible while removing ~/Library must
 * not.
 */
function protectedPaths() {
  const list = [
    '/', '/System', '/Library', '/Applications', '/Users', '/usr', '/bin', '/sbin',
    '/etc', '/var', '/tmp', '/private', '/opt', '/cores', '/Volumes', '/dev',
    HOME,
    // A handful of home folders whose wholesale removal is never what was meant.
    ...['Library', 'Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music',
      'Applications', 'Public', '.ssh', '.gnupg', '.config', 'Development', 'Developer',
    ].map((d) => `${HOME}${sep}${d}`),
  ];
  if (PLATFORM === 'win32') {
    list.push('C:\\', 'C:\\Windows', 'C:\\Users', 'C:\\Program Files', 'C:\\Program Files (x86)');
  }
  return new Set(list.map((p) => normalize(p).replace(/[/\\]+$/, '') || sep));
}

const PROTECTED = protectedPaths();

export class UnsafePathError extends Error {}

/**
 * Throw unless `target` is safe to delete within this scan.
 * Returns the normalised absolute path on success.
 */
export function assertDeletable(target, rootPath, { readOnly = false } = {}) {
  if (readOnly) {
    throw new UnsafePathError('onlyfiles is running in --read-only mode; deletion is disabled');
  }
  if (typeof target !== 'string' || !target.trim()) {
    throw new UnsafePathError('No path given');
  }

  const path = resolve(normalize(target));
  const root = resolve(normalize(rootPath));

  // Must sit strictly inside the directory that was scanned. The trailing
  // separator matters: without it "/Users/foo" would appear to contain
  // "/Users/foobar".
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (path === root) {
    throw new UnsafePathError(`Refusing to delete the scan root itself: ${path}`);
  }
  if (!path.startsWith(rootWithSep)) {
    throw new UnsafePathError(`Refusing to delete outside the scanned folder: ${path}`);
  }

  const bare = path.replace(/[/\\]+$/, '') || sep;
  if (PROTECTED.has(bare)) {
    throw new UnsafePathError(`Refusing to delete a protected location: ${path}`);
  }

  // Must actually exist. lstat, not stat: a dangling symlink is still deletable.
  try {
    lstatSync(path);
  } catch {
    throw new UnsafePathError(`Path does not exist: ${path}`);
  }

  return path;
}

/**
 * Delete one path. mode 'trash' is recoverable and the default everywhere in the
 * UI; 'permanent' is unrecoverable and the UI makes the user type the word out.
 */
export async function deletePath(target, rootPath, { mode = 'trash', readOnly = false } = {}) {
  const path = assertDeletable(target, rootPath, { readOnly });

  if (mode === 'permanent') {
    rmSync(path, { recursive: true, force: true });
    return { path, mode };
  }

  await trash([path]);
  return { path, mode: 'trash' };
}

function run(cmd, args) {
  return new Promise((res) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => res(false));
      // Windows Explorer exits 1 even when it worked, so treat launch as success.
      child.unref();
      res(true);
    } catch {
      res(false);
    }
  });
}

/** Show the item selected in the platform's file manager. */
export async function revealInFileManager(path) {
  const p = resolve(path);
  if (PLATFORM === 'darwin') return run('open', ['-R', p]);
  if (PLATFORM === 'win32') return run('explorer.exe', [`/select,${p}`]);

  // Linux: the freedesktop FileManager1 interface selects the item; if no
  // implementation is listening, settle for opening the containing folder.
  const ok = await run('dbus-send', [
    '--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
    '--type=method_call', '/org/freedesktop/FileManager1',
    'org.freedesktop.FileManager1.ShowItems',
    `array:string:file://${p}`, 'string:""',
  ]);
  return ok || run('xdg-open', [dirname(p)]);
}

/** Open a file or folder with the OS default handler. */
export async function openPath(path) {
  const p = resolve(path);
  if (PLATFORM === 'darwin') return run('open', [p]);
  if (PLATFORM === 'win32') return run('cmd', ['/c', 'start', '', p]);
  return run('xdg-open', [p]);
}

/** Open a URL in the default browser. */
export async function openBrowser(url) {
  if (PLATFORM === 'darwin') return run('open', [url]);
  if (PLATFORM === 'win32') return run('cmd', ['/c', 'start', '', url]);
  return run('xdg-open', [url]);
}

export const fileManagerName =
  PLATFORM === 'darwin' ? 'Finder' : PLATFORM === 'win32' ? 'Explorer' : 'file manager';
