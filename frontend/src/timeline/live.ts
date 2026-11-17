/**
 * The page's one timeline, filled from the socket for as long as the page is
 * open — whether or not a chart is on screen, so it is already full when the
 * Radio tab is opened.
 */
import { backendSnapshot, getServerTime, onBackendEvent } from '../hooks/useBackend';
import { FieldTimeline } from '../../../src/timeline/store';

export const liveTimeline = new FieldTimeline();

let started = false;

/** Start filling {@link liveTimeline}. Safe to call from every page that
 *  wants it; only the first call does anything. */
export function startLiveTimeline(): void {
  if (started) return;
  started = true;

  // Anything that arrived before this ran.
  const snapshot = backendSnapshot();
  liveTimeline.ingestHistory(snapshot.history);
  if (snapshot.matchState) liveTimeline.ingestMatchPhase(snapshot.matchState.phase, getServerTime());
  if (snapshot.radioReconfigure) liveTimeline.ingestReconfigure(snapshot.radioReconfigure, getServerTime());
  if (snapshot.robotDropouts) liveTimeline.ingestDropouts(snapshot.robotDropouts);

  onBackendEvent('history', entries => liveTimeline.ingestHistory(entries));
  onBackendEvent('update', entry => liveTimeline.ingestStatus(entry));
  onBackendEvent('telemetry', update => liveTimeline.ingestTelemetry(update));
  onBackendEvent('matchState', state => liveTimeline.ingestMatchPhase(state.phase, getServerTime()));
  onBackendEvent('radioReconfigure', state => liveTimeline.ingestReconfigure(state, getServerTime()));
  onBackendEvent('robotDropouts', state => liveTimeline.ingestDropouts(state));
  // What the server kept from before this page opened (pages that ask for it).
  onBackendEvent('timelineSnapshot', snapshot => liveTimeline.hydrate(snapshot));

  setInterval(() => liveTimeline.trim(getServerTime()), 5_000);
}
