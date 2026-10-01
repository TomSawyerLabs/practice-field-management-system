/**
 * The moment on screen, shared by the player, the timeline and the readout
 * without going through React state: it changes every animation frame during
 * playback, and only the things that draw it should hear about it.
 */
export interface Playhead {
  get(): number;
  set(t: number): void;
  subscribe(fn: (t: number) => void): () => void;
}

export function createPlayhead(initial: number): Playhead {
  let t = initial;
  const subs = new Set<(t: number) => void>();
  return {
    get: () => t,
    set(next) {
      if (next === t) return;
      t = next;
      for (const fn of subs) fn(t);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
