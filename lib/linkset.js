// A lock-free set of inode numbers, shared across every scan thread.
//
// Why this exists: a hardlinked file occupies its blocks once, no matter how
// many names point at it, so its bytes must be counted exactly once — that is
// what `du` does. Giving each worker its own table makes the grand total depend
// on how subtrees happened to be scheduled, which produced totals varying by
// almost a gigabyte between runs. One shared table makes the total exact and
// reproducible regardless of worker count.
//
// Open addressing with linear probing over a SharedArrayBuffer. Claiming a slot
// is a single compareExchange, so "who counted this inode first" is resolved
// atomically without any lock. Which *directory* gets charged for a hardlink
// family spanning several folders still depends on scan order — unavoidable, and
// `du` behaves the same way.

const EMPTY = 0n; // inode 0 never exists, so it is a safe empty marker

export class LinkSet {
  /**
   * @param {number} slots  power-of-two capacity. 1<<20 slots is 8 MB and holds
   *   ~700k hardlinked inodes at a 0.7 load factor; beyond that `add` degrades
   *   to "count it" rather than probing forever.
   */
  constructor(slots = 1 << 20, buffer = null) {
    this.slots = slots;
    this.mask = BigInt(slots - 1);
    this.buffer = buffer || new SharedArrayBuffer(slots * 8);
    this.table = new BigUint64Array(this.buffer);
    this.maxProbe = 64;
  }

  /** Rebuild a view onto an existing table inside a worker. */
  static fromBuffer(buffer) {
    return new LinkSet(buffer.byteLength / 8, buffer);
  }

  /**
   * Returns true if this call is the one that should count the inode's bytes,
   * false if some thread already claimed it.
   */
  add(ino) {
    const key = BigInt(ino);
    if (key === EMPTY) return true; // shouldn't happen; count rather than lose bytes

    // Fibonacci hashing, then mask down to a slot index.
    let idx = Number(((key * 11400714819323198485n) >> 32n) & this.mask);

    for (let probe = 0; probe < this.maxProbe; probe++) {
      const prev = Atomics.compareExchange(this.table, idx, EMPTY, key);
      if (prev === EMPTY) return true; // we claimed the slot: first sighting
      if (prev === key) return false; // already counted by someone
      idx = (idx + 1) & Number(this.mask);
    }

    // Table is congested. Counting the bytes twice is a smaller error than
    // silently dropping them, so fail open.
    return true;
  }
}
