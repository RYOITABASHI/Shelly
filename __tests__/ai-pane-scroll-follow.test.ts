/**
 * createRafCoalescer: bursts of call() collapse into one rAF invocation;
 * a call after the frame schedules again; cancel() drops a pending frame.
 */
import { createRafCoalescer } from '@/lib/ai-pane-scroll-follow';

describe('createRafCoalescer', () => {
  let queue: Map<number, FrameRequestCallback>;
  let nextId: number;
  const originalRaf = global.requestAnimationFrame;
  const originalCaf = global.cancelAnimationFrame;

  function flushFrame() {
    const pending = [...queue.values()];
    queue.clear();
    pending.forEach((cb) => cb(0));
  }

  beforeEach(() => {
    queue = new Map();
    nextId = 1;
    global.requestAnimationFrame = jest.fn((cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    }) as typeof requestAnimationFrame;
    global.cancelAnimationFrame = jest.fn((id: number) => {
      queue.delete(id);
    }) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCaf;
  });

  it('runs fn exactly once for several calls before the frame', () => {
    const fn = jest.fn();
    const c = createRafCoalescer(fn);
    c.call();
    c.call();
    c.call();
    expect(fn).not.toHaveBeenCalled();
    expect(global.requestAnimationFrame).toHaveBeenCalledTimes(1);
    flushFrame();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('schedules again for a call after the frame fired', () => {
    const fn = jest.fn();
    const c = createRafCoalescer(fn);
    c.call();
    flushFrame();
    c.call();
    expect(global.requestAnimationFrame).toHaveBeenCalledTimes(2);
    flushFrame();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('never runs fn when cancelled before the frame', () => {
    const fn = jest.fn();
    const c = createRafCoalescer(fn);
    c.call();
    c.cancel();
    expect(global.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    flushFrame();
    expect(fn).not.toHaveBeenCalled();
  });
});
