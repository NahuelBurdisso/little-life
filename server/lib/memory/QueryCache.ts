import { QUERY_CACHE_CAPACITY } from './constants';

export class QueryCache {
  private cache: Map<string, Float32Array> = new Map();
  private capacity: number;

  constructor(capacity = QUERY_CACHE_CAPACITY) {
    this.capacity = capacity;
  }

  get(key: string): Float32Array | undefined {
    const val = this.cache.get(key);
    if (val) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  set(key: string, value: Float32Array): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
