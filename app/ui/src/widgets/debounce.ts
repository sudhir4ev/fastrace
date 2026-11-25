// Debounces viewport-driven refetches (pan/zoom) so LOD recompute happens
// on pan-end/zoom-change, not continuously mid-drag (`docs/adr/0009`).
export function createDebouncer<Args extends unknown[]>(
  delayMs: number,
  fn: (...args: Args) => void
): { call: (...args: Args) => void; cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Args | undefined;
  return {
    call: (...args: Args) => {
      if (timer !== undefined) clearTimeout(timer);
      lastArgs = args;
      timer = setTimeout(() => fn(...args), delayMs);
    },
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    flush: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      fn(...(lastArgs as Args));
    },
  };
}
