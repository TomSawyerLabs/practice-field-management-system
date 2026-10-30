import { useEffect, useReducer } from 'react';

/** Re-render once a second while enabled, for text worked out from the clock
 *  ("5s ago") that no incoming state would otherwise refresh. */
export function useSecondTick(enabled = true) {
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [enabled]);
}
