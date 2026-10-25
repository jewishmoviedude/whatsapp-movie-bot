/**
 * Counting semaphore for stage-level concurrency.
 *
 * The movie pipeline used to run whole jobs one at a time. That wasted the
 * box: while a 2-hour film re-encoded (CPU-bound), the network sat idle, and
 * while a finished film uploaded (network-bound), the CPU sat idle. These
 * semaphores let stages from *different* jobs overlap - one download, one
 * convert and one upload at once - while still capping each stage so a single
 * download cannot compete with another for bandwidth, or two ffmpegs for RAM.
 */
export class Semaphore {
  constructor(capacity = 1, name = 'sem') {
    this.capacity = Math.max(1, capacity);
    this.name = name;
    this.inUse = 0;
    this.waiters = [];
  }

  get waiting() { return this.waiters.length; }
  get free() { return this.capacity - this.inUse; }

  /**
   * Resolves once a slot is held. Always pair with release() in a finally.
   *
   * `priority` decides who gets the next free slot: higher goes first, and
   * equal priorities keep arrival order. Without this the queue's "movies
   * first" decision was undone one line later - a movie that had correctly
   * jumped ahead of fifteen waiting episodes then joined this list behind a TV
   * download and sat at 2% until the episode finished.
   */
  /**
   * Ask the lowest-priority holder to give its slot up, if anyone outranks it.
   *
   * Reserving a queue slot gets a movie STARTED immediately, but it would then
   * still sit behind whatever episode already holds the download slot. For a
   * movie that is supposed to take precedence outright, waiting out an episode
   * is still waiting. Yielding is cooperative: the holder is asked, aborts what
   * it is doing, and retries - so nothing is killed, only restarted.
   */
  _askLowestToYield(priority) {
    let victim = null;
    for (const h of this._holders ?? []) {
      if (h.priority >= priority || !h.onPreempt || h.yielding) continue;
      if (!victim || h.priority < victim.priority) victim = h;
    }
    if (!victim) return false;
    victim.yielding = true;
    try { victim.onPreempt(); } catch { /* a holder that cannot yield keeps its slot */ }
    return true;
  }

  /**
   * `key` names the waiter (the queue's job id) so an admin can move it up
   * the line from the panel - see promote(). It changes nothing else.
   */
  acquire(priority = 0, label = null, { onPreempt = null, key = null } = {}) {
    this._held ??= new Set();
    this._holders ??= new Set();
    const mine = { priority, label, onPreempt, yielding: false };
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      if (label) this._held.add(label);
      this._holders.add(mine);
      this._mineByLabel ??= new Map();
      if (label) this._mineByLabel.set(label, mine);
      return Promise.resolve();
    }
    // No slot. If something lower-priority is holding one, ask it to step aside.
    this._askLowestToYield(priority);
    return new Promise((resolve) => {
      const entry = { resolve, priority, label, onPreempt, key, seq: this._seq = (this._seq ?? 0) + 1 };
      // Insert AFTER everyone of equal-or-higher priority, so arrival order
      // still decides between equals - a later movie must not overtake an
      // earlier one.
      let i = this.waiters.length;
      while (i > 0 && this.waiters[i - 1].priority < priority) i--;
      this.waiters.splice(i, 0, entry);
    });
  }

  release(label = null) {
    this._held ??= new Set();
    this._holders ??= new Set();
    this._mineByLabel ??= new Map();
    if (label) {
      this._held.delete(label);
      const h = this._mineByLabel.get(label);
      if (h) { this._holders.delete(h); this._mineByLabel.delete(label); }
    } else {
      // Un-labelled release: drop any one holder so the set cannot leak.
      const any = this._holders.values().next().value;
      if (any) this._holders.delete(any);
    }
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter; inUse stays the same.
      if (next.label) this._held.add(next.label);
      const h = { priority: next.priority, label: next.label, onPreempt: next.onPreempt, yielding: false };
      this._holders.add(h);
      if (next.label) this._mineByLabel.set(next.label, h);
      next.resolve();
    } else {
      this.inUse = Math.max(0, this.inUse - 1);
    }
  }

  /** Where the waiter with this key stands: 1 is next, 0 is not waiting here. */
  position(key) {
    return key == null ? 0 : this.waiters.findIndex((w) => w.key === key) + 1;
  }

  /**
   * Move a waiter forward, because an admin said so: 'up' passes the one
   * ahead of it, 'top' makes it next. False when it is not waiting here or is
   * already next.
   *
   * Asked for from the live panel: three films were downloaded and waiting
   * for the one encoder, in the order they happened to finish downloading,
   * and there was no way to say which should be converted first. The job
   * currently holding the slot keeps it - an encode is not thrown away - so
   * this only decides who goes next.
   *
   * The moved waiter takes the priority of the one it passes. acquire()
   * places a newcomer after everyone of equal or higher priority, so without
   * this a movie arriving a second later would slip straight back in front
   * of a TV episode the admin had just put first.
   */
  promote(key, dir = 'top') {
    const i = key == null ? -1 : this.waiters.findIndex((w) => w.key === key);
    if (i <= 0) return false;
    const to = dir === 'up' ? i - 1 : 0;
    const [w] = this.waiters.splice(i, 1);
    w.priority = Math.max(w.priority, this.waiters[to].priority);
    this.waiters.splice(to, 0, w);
    return true;
  }

  /** Labels of the jobs currently holding slots, for an honest wait message. */
  holders() {
    return [...this._held ?? []];
  }

  /** What is queued, by priority - used to explain a wait accurately. */
  waitingByPriority() {
    const out = {};
    for (const w of this.waiters) out[w.priority] = (out[w.priority] ?? 0) + 1;
    return out;
  }

  /** Run fn while holding a slot, releasing even if it throws. */
  async run(fn, priority = 0) {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Resize at runtime when the config changes. */
  setCapacity(n) {
    const target = Math.max(1, n);
    const grew = target - this.capacity;
    this.capacity = target;
    // If we grew, wake as many waiters as new slots allow.
    for (let i = 0; i < grew; i++) {
      if (this.inUse < this.capacity && this.waiters.length) {
        this.inUse += 1;
        this.waiters.shift().resolve();
      }
    }
  }

  stats() {
    return { name: this.name, capacity: this.capacity, inUse: this.inUse, waiting: this.waiters.length };
  }
}
