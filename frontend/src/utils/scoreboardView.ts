// ── Scoreboard view (browser-local) ─────────────────────────────────
// A TV shows either the match scoreboard or, on a speed challenge day, the
// leaderboard full screen. Like the other display settings it lives in
// localStorage, with ?view=leaderboard as an override, and is pushed to Cast
// TVs by the sender and from the admin page's display list. Read once — it
// changes which page is mounted, so switching reloads.

import { isScoreboardView, type ScoreboardView } from '../../../src/types';

function getInitialView(): ScoreboardView {
  const param = new URLSearchParams(window.location.search).get('view');
  if (isScoreboardView(param)) return param;
  const stored = localStorage.getItem('scoreboard-view');
  return isScoreboardView(stored) ? stored : 'scoreboard';
}

export const SCOREBOARD_VIEW = getInitialView();

export function switchScoreboardView(view: ScoreboardView) {
  localStorage.setItem('scoreboard-view', view);
  window.__castSendView?.(view);
  const url = new URL(window.location.href);
  url.searchParams.delete('view');
  window.location.replace(url.toString());
}
