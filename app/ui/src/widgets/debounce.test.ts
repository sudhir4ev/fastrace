import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncer } from "./debounce";

describe("createDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only invokes once, with the last call's args, after the delay", () => {
    const calls: number[] = [];
    const debouncer = createDebouncer(100, (n: number) => calls.push(n));
    debouncer.call(1);
    debouncer.call(2);
    debouncer.call(3);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([3]);
  });

  it("cancel() prevents the pending call", () => {
    const calls: number[] = [];
    const debouncer = createDebouncer(100, (n: number) => calls.push(n));
    debouncer.call(1);
    debouncer.cancel();
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([]);
  });

  it("flush() with a pending call invokes fn immediately with the last args", () => {
    const calls: number[] = [];
    const debouncer = createDebouncer(100, (n: number) => calls.push(n));
    debouncer.call(1);
    debouncer.call(2);
    debouncer.flush();
    expect(calls).toEqual([2]);
  });

  it("flush() with no pending call is a no-op", () => {
    const calls: number[] = [];
    const debouncer = createDebouncer(100, (n: number) => calls.push(n));
    debouncer.flush();
    expect(calls).toEqual([]);
  });

  it("flush() does not double-invoke when the timer would have fired later", () => {
    const calls: number[] = [];
    const debouncer = createDebouncer(100, (n: number) => calls.push(n));
    debouncer.call(1);
    debouncer.flush();
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([1]);
  });
});
