/** FIFO counting semaphore. */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return this.releaser();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const grant = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      const i = this.queue.indexOf(grant);
      if (i !== -1) this.queue.splice(i, 1);
      reject(new Error('취소됨'));
    };
    if (signal?.aborted) onAbort();
    else {
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
    }
    await promise; // the releasing holder handed its slot straight to us
    return this.releaser();
  }

  private releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}

export const cliSlots = new Semaphore(3);
