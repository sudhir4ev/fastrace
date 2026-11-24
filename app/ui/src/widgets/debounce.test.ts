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
});
