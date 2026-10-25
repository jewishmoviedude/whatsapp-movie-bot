/**
 * A rolling counter over a time window, in fixed memory.
 *
 * The obvious implementation - push a timestamp per event, filter the old ones
 * out on read - is a slow leak. This process runs for weeks without a restart
 * and can emit thousands of actions an hour, so an unbounded array is not an
 * option and neither is a filter that walks it.
 *
 * Instead the window is divided into buckets held in a ring. Advancing the ring
 * zeroes whatever it passes over, so memory is exactly `buckets` integers for
 * ever, and both add() and count() are O(buckets) at worst regardless of how
 * many events went in.
 *
 * The trade is resolution: a 60-bucket hour means the window is accurate to the
 * minute, and an event ages out somewhere between 59 and 60 minutes. That is
 * far finer than any decision made from it.
 *
 * `now` is injectable so this can be tested without waiting an hour.
 */
export class RateWindow {
  /**
   * @param {object}   opts
   * @param {number}   opts.windowMs  how far back the count reaches
   * @param {number}   opts.buckets   resolution; more buckets = finer, more memory
   * @param {Function} opts.now       clock, for tests
   */
  constructor({ windowMs, buckets = 60, now = Date.now } = {}) {
    if (!(windowMs > 0)) throw new Error('windowMs must be positive');
    this.windowMs = windowMs;
    this.buckets = Math.max(1, Math.floor(buckets));
    this.bucketMs = windowMs / this.buckets;
    this.now = now;

    this._counts = new Array(this.buckets).fill(0);
    // Which absolute bucket index each slot currently holds, so a slot from a
    // previous lap is recognised as stale rather than counted.
    this._stamps = new Array(this.buckets).fill(-1);
  }

  /** Absolute bucket number for a moment in time. */
  _index(at) {
    return Math.floor(at / this.bucketMs);
  }

  /** Zero any slot holding a bucket older than the window. */
  _expire(at) {
    const oldest = this._index(at) - this.buckets + 1;
    for (let i = 0; i < this.buckets; i += 1) {
      if (this._stamps[i] < oldest) {
        this._stamps[i] = -1;
        this._counts[i] = 0;
      }
    }
  }

  /** Record `n` events now. */
  add(n = 1) {
    const at = this.now();
    const idx = this._index(at);
    const slot = ((idx % this.buckets) + this.buckets) % this.buckets;

    // A slot still holding an older lap is reused, not added to - otherwise a
    // quiet hour would inherit the count from the hour before it.
    if (this._stamps[slot] !== idx) {
      this._stamps[slot] = idx;
      this._counts[slot] = 0;
    }
    this._counts[slot] += n;
    this._expire(at);
    return this._counts[slot];
  }

  /** How many events fall inside the window ending now. */
  count() {
    const at = this.now();
    const oldest = this._index(at) - this.buckets + 1;
    let total = 0;
    for (let i = 0; i < this.buckets; i += 1) {
      if (this._stamps[i] >= oldest) total += this._counts[i];
    }
    return total;
  }

  /** Fraction of `limit` used, clamped at 0 and unbounded above. */
  fractionOf(limit) {
    if (!(limit > 0)) return 0;
    return this.count() / limit;
  }

  /** Drop everything. Used when the operator changes the limits. */
  reset() {
    this._counts.fill(0);
    this._stamps.fill(-1);
  }

  /**
   * Serialise, so a count can survive a restart.
   *
   * Without this the budget resets to zero every time the process starts, and a
   * crash loop would evade it completely - which is the exact situation a volume
   * ceiling exists for. The stamps are ABSOLUTE bucket indices rather than
   * offsets, so a restored window ages correctly no matter how long the process
   * was down: anything older than the window simply falls out on the first read.
   */
  toJSON() {
    return { v: 1, bucketMs: this.bucketMs, counts: [...this._counts], stamps: [...this._stamps] };
  }

  /**
   * Restore a serialised window. Silently ignores anything that does not match
   * the current shape - a changed bucket size makes the old indices meaningless,
   * and starting from zero is a far better failure than counting nonsense.
   */
  restore(data) {
    if (!data || data.v !== 1) return false;
    if (data.bucketMs !== this.bucketMs) return false;
    if (!Array.isArray(data.counts) || data.counts.length !== this.buckets) return false;
    if (!Array.isArray(data.stamps) || data.stamps.length !== this.buckets) return false;
    for (let i = 0; i < this.buckets; i += 1) {
      const c = Number(data.counts[i]);
      const st = Number(data.stamps[i]);
      this._counts[i] = Number.isFinite(c) && c >= 0 ? c : 0;
      this._stamps[i] = Number.isFinite(st) ? st : -1;
    }
    this._expire(this.now());
    return true;
  }
}
