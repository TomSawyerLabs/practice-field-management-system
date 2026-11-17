import { useEffect, useRef, useState } from 'react';
import type { ReconfigureStationChange } from '../../../src/types';
import { useHistory, useLatest, useRadioReconfigure, serverToBrowserTime } from './useBackend';

/** How long a radio reconfigure usually takes, for the countdown, until the
 *  server has timed some on this radio. */
export const ESTIMATED_RECONFIGURATION_SECONDS = 40;

export interface ReconfigProgress {
  /** The AP's last reported status, or undefined when it is not answering. */
  status: 'BOOTING' | 'CONFIGURING' | 'ACTIVE' | 'ERROR' | undefined;
  isConfiguring: boolean;
  /** Seconds since the reconfigure began, or null when the start is unknown
   *  (the page loaded mid-reconfigure after the history window pruned it). */
  elapsedSec: number | null;
  /** How long this reconfigure is expected to take. */
  estimatedSec: number;
  /** The stations it changes. Empty when the server hasn't said, or when it
   *  only re-applies what the radio should already have. */
  changes: ReconfigureStationChange[];
}

/** Where a radio reconfigure stands. Two sources: the server says when it
 *  sends the radio a configuration and what that changes (the only source
 *  on the read-only scoreboard socket), and the radio's own polled status,
 *  which also catches a reconfigure pFMS didn't start. For the latter the
 *  anchor is the last ACTIVE status before CONFIGURING (or the first
 *  CONFIGURING entry if the page was opened mid-way), pinned to browser
 *  time once per cycle so the countdown does not jitter as the server clock
 *  offset settles. */
export function useReconfigProgress(): ReconfigProgress {
  const latest = useLatest();
  const server = useRadioReconfigure();
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
  const serverSince = server?.active ? (server.since ?? null) : null;
  const reconfigStart = serverSince ?? lastActive ?? firstConfiguring;

  const status = latest?.radioUpdate?.status;
  const radioConfiguring = status === 'CONFIGURING';
  const isConfiguring = radioConfiguring || !!server?.active;
  const isRadioConnected = latest?.radioUpdate !== undefined;

  const [elapsedSec, setElapsedSec] = useState<number | null>(null);
  const startTimeRef = useRef<number | null>(null);

  // Only clear the anchor when definitively done — not on a transient
  // flicker, such as the radio dropping out of the status poll mid-way. The
  // scoreboard never sees the radio, so there the server's word is enough.
  const isDefinitelyDone = !isConfiguring && (isRadioConnected || server !== null);
  useEffect(() => {
    if (isDefinitelyDone) {
      startTimeRef.current = null;
      setElapsedSec(null);
    }
  }, [isDefinitelyDone]);

  useEffect(() => {
    if (!isConfiguring || !reconfigStart) return;

    // Compute the browser-local anchor only once per reconfiguration cycle,
    // except that the server's start replaces a guess from radio status.
    if (startTimeRef.current === null || serverSince !== null) {
      startTimeRef.current = serverToBrowserTime(reconfigStart);
    }

    const startBrowserTime = startTimeRef.current;
    const update = () => setElapsedSec(Math.max(0, (Date.now() - startBrowserTime) / 1000));
    update();
    const interval = setInterval(update, 100);
    return () => clearInterval(interval);
  }, [isConfiguring, reconfigStart, serverSince]);

  return {
    status,
    isConfiguring,
    elapsedSec: isConfiguring ? elapsedSec : null,
    estimatedSec: (server?.expectedMs ?? ESTIMATED_RECONFIGURATION_SECONDS * 1000) / 1000,
    changes: server?.active ? server.changes : [],
  };
}
