import type { SliceSource } from './sources';
import { toLoadedFrame, type LoadedFrame } from './skiaFrames';

/**
 * LRU cache of GPU-ready frames with a small prefetch queue that fans out
 * from the slice currently on screen.
 */
export class FrameCache {
  private cache = new Map<number, LoadedFrame>();
  private inflight = new Map<number, Promise<LoadedFrame>>();
  private queue: number[] = [];
  private active = 0;
  private disposed = false;

  constructor(
    private readonly source: SliceSource,
    private readonly capacity = 96,
    private readonly concurrency = 4,
  ) {}

  peek(i: number): LoadedFrame | undefined {
    const f = this.cache.get(i);
    if (f) {
      this.cache.delete(i);
      this.cache.set(i, f);
    }
    return f;
  }

  load(i: number): Promise<LoadedFrame> {
    const cached = this.peek(i);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(i);
    if (pending) return pending;
    const p = this.source
      .load(i)
      .then((decoded) => {
        const frame = toLoadedFrame(decoded);
        if (!this.disposed) this.put(i, frame);
        return frame;
      })
      .finally(() => this.inflight.delete(i));
    this.inflight.set(i, p);
    return p;
  }

  prefetch(center: number, radius = 24): void {
    const order: number[] = [];
    const r = Math.min(radius, Math.floor(this.capacity / 2) - 1);
    for (let k = 1; k <= r; k++) {
      // Lean forward: scrolling usually continues in the same direction.
      for (const i of [center + k, center - k]) {
        if (i >= 0 && i < this.source.count && !this.cache.has(i) && !this.inflight.has(i)) {
          order.push(i);
        }
      }
    }
    this.queue = order;
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.cache.clear();
  }

  private put(i: number, f: LoadedFrame): void {
    this.cache.set(i, f);
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value as number;
      this.cache.delete(oldest);
    }
  }

  private pump(): void {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const i = this.queue.shift() as number;
      if (this.cache.has(i) || this.inflight.has(i)) continue;
      this.active++;
      this.load(i)
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
