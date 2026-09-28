import { useEffect, useRef, useState } from 'react';
import { useHistory, useLatest, serverToBrowserTime } from './useBackend';

/** How long a radio reconfigure usually takes, for the countdown. */
export const ESTIMATED_RECONFIGURATION_SECONDS = 40;

export interface ReconfigProgress {
  /** The AP's last reported status, or undefined when it is not answering. */
  status: 'BOOTING' | 'CONFIGURING' | 'ACTIVE' | 'ERROR' | undefined;
  isConfiguring: boolean;
  /** Seconds since the reconfigure began, or null when the start is unknown
   *  (the page loaded mid-reconfigure after the history window pruned it). */
  elapsedSec: number | null;
}

/** Where a radio reconfigure stands, for the full-screen backdrop and for
 *  pages that must stay usable through one. The anchor is the last ACTIVE
 *  status before CONFIGURING (or the first CONFIGURING entry if the page was
 *  opened mid-way), pinned to browser time once per cycle so the countdown
 *  does not jitter as the server clock offset settles. */
export function useReconfigProgress(): ReconfigProgress {
  const latest = useLatest();
  // .slice() to avoid mutating the state array — .reverse() is in-place and
  // would cause lastActive to oscillate between the first and last ACTIVE
  // entries on alternating renders.
  const hist = useHistory();
  const lastActive =
    hist
      .slice()
      .reverse()
      .find(h => h.radioUpdate?.status === 'ACTIVE')?.timestamp || null;
  // When the page is refreshed mid-reconfiguration, the server's history window
  // may have already pruned all ACTIVE entries. Fall back to the first
  // CONFIGURING entry so the countdown still has an anchor point.
  const firstConfiguring = hist.find(h => h.radioUpdate?.status === 'CONFIGURING')?.timestamp || null;
  const reconfigStart = lastActive ?? firstConfiguring;

  const status = latest?.radioUpdate?.status;
  const isConfiguring = status === 'CONFIGURING';
  const isRadioConnected = latest?.radioUpdate !== undefined;

  const [elapsedSec, setElapsedSec] = useState<number | null>(null);
  const startTimeRef = useRef<number | null>(null);

  // Only clear the anchor when the radio is definitively done configuring
  // (connected with a non-CONFIGURING status), not on transient flickers.
  const isDefinitelyDone = isRadioConnected && !isConfiguring;
  useEffect(() => {
    if (isDefinitelyDone) {
      startTimeRef.current = null;
      setElapsedSec(null);
    }
  }, [isDefinitelyDone]);

  useEffect(() => {
    if (!isConfiguring || !reconfigStart) return;

    // Compute the browser-local anchor only once per reconfiguration cycle
    if (startTimeRef.current === null) {
      startTimeRef.current = serverToBrowserTime(reconfigStart);
    }

    const startBrowserTime = startTimeRef.current;
    const update = () => setElapsedSec((Date.now() - startBrowserTime) / 1000);
    update();
    const interval = setInterval(update, 100);
    return () => clearInterval(interval);
  }, [isConfiguring, reconfigStart]);

  return { status, isConfiguring, elapsedSec: isConfiguring ? elapsedSec : null };
}
