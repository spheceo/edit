/** Owns decoded resources; eviction and project changes release them immediately. */
export class DecodedCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  bytes = 0;

  constructor(readonly budget: number, private release: (value: T) => void) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: string) { return this.entries.has(key); }

  set(key: string, value: T, bytes: number) {
    this.delete(key);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    // Always allow one oversized frame, so high-resolution sources remain usable.
    while (this.bytes > this.budget && this.entries.size > 1) this.delete(this.entries.keys().next().value!);
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    this.release(entry.value);
  }

  deletePrefix(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.delete(key);
  }

  clear() {
    for (const key of this.entries.keys()) this.delete(key);
  }

  get size() { return this.entries.size; }
}
