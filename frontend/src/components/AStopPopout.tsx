import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { MatchPhase, MatchState, StationName } from '../../../src/types';
import {
  useMatchState,
  sendStationReady,
  sendStationSelfAStop,
  sendStationClearAStop,
  sendStationSelfEStop,
  sendStationSelfUndisable,
} from '../hooks/useBackend';
import { useMatchAudio } from '../hooks/useMatchAudio';

/**
 * The match pop-out window. One named browser window that follows the match:
 *
 * 1. **Setup** — opened by the Join button click (a user gesture, so it is
 *    never pop-up-blocked). Shows everyone's ready status, a Ready toggle,
 *    A-Stop pre-arm, this robot's E-Stop, and a "close at match start" option.
 * 2. **Match** — from the countdown the same window shows the phase + timer.
 *    During countdown/auto it is dominated by a giant A-STOP button; after
 *    auto the A-Stop is gone (released for teleop) and the timer + E-Stop
 *    remain. It closes at post-match.
 *
 * It also closes when the station leaves the match, when the page goes away,
 * and — if the "close at match start" box is ticked — at the countdown.
 *
 * The window content is plain DOM built by hand (not a React portal): MUI's
 * styles live in the opener's document, and React event delegation does not
 * cross into another window's document. All dynamic data is set via
 * textContent — no user data goes through innerHTML.
 *
 * Module-level state so the window survives React re-renders and can be opened
 * from the Join button's own click handler.
 */
type PopupMode = 'setup' | 'match';

const CLOSE_AT_START_KEY = 'pfms-match-popup-close-at-start';
const MUTED_KEY = 'pfms-match-popup-muted';

function closeAtStartPref(): boolean {
  try {
    return localStorage.getItem(CLOSE_AT_START_KEY) === '1';
  } catch {
    return false;
  }
}

function setCloseAtStartPref(v: boolean) {
  try {
    localStorage.setItem(CLOSE_AT_START_KEY, v ? '1' : '0');
  } catch {
    // Ignore quota/privacy failures — the checkbox just won't persist.
  }
}

/** Pop-up match audio — default muted (the pop-up is often next to the field
 *  speaker). Module-level so the hand-built window and the React audio hook
 *  agree; subscribers re-render when the toggle flips. */
function mutedPref(): boolean {
  try {
    // Default muted: anything other than an explicit '0' is muted.
    return localStorage.getItem(MUTED_KEY) !== '0';
  } catch {
    return true;
  }
}

let popupMuted = mutedPref();
const mutedSubs = new Set<() => void>();

function togglePopupMuted() {
  popupMuted = !popupMuted;
  try {
    localStorage.setItem(MUTED_KEY, popupMuted ? '1' : '0');
  } catch {
    // Ignore — the toggle just won't persist.
  }
  mutedSubs.forEach(f => f());
  refreshConsole();
}

type ConsoleRobot = {
  team: number | null;
  alliance: 'red' | 'blue' | null;
  ready: boolean;
  self: boolean;
};

type ConsoleState = {
  station: StationName;
  phase: MatchPhase;
  pausedFrom?: MatchPhase;
  remainingTime: number;
  readyRequested: boolean;
  ready: boolean;
  aStop: boolean;
  eStop: boolean;
  enabled: boolean;
  disabledBy: 'ds' | 'self' | 'admin' | null;
  robots: ConsoleRobot[];
};

let popupWin: Window | null = null;
let popupOpenedAt = 0;
let lastState: ConsoleState | null = null;

// Console element refs (valid while the current window's DOM is built)
let phaseEl: HTMLElement | null = null;
let timerEl: HTMLElement | null = null;
let robotsEl: HTMLElement | null = null;
let hintEl: HTMLElement | null = null;
let readyBtn: HTMLButtonElement | null = null;
let muteBtn: HTMLButtonElement | null = null;
let astopBtn: HTMLButtonElement | null = null;
let reenableBtn: HTMLButtonElement | null = null;
let estopBtn: HTMLButtonElement | null = null;
let footerEl: HTMLElement | null = null;
let closeBox: HTMLInputElement | null = null;

function popupIsOpen(): boolean {
  return !!popupWin && !popupWin.closed;
}

function ensureWindow(): Window | null {
  if (popupWin && !popupWin.closed) return popupWin;
  const w = window.open('', 'pfms-astop', 'popup=yes,width=540,height=520');
  if (!w) return null;
  popupWin = w;
  phaseEl = null; // force a rebuild — a reused named window may hold stale content
  popupOpenedAt = Date.now();
  return w;
}

function closePopup() {
  if (popupWin && !popupWin.closed) popupWin.close();
  popupWin = null;
  phaseEl = null;
}

const phaseLabels: Partial<Record<MatchPhase, string>> = {
  created: 'Match Setup',
  countdown: 'Countdown',
  auto: 'Autonomous',
  autoPause: 'Pause',
  paused: 'Match Paused',
  teleop: 'Teleoperated',
  endgame: 'Endgame',
};

const phaseColors: Partial<Record<MatchPhase, string>> = {
  created: '#4fc3f7',
  countdown: '#ffb300',
  auto: '#4fc3f7',
  autoPause: '#9e9e9e',
  paused: '#ffb300',
  teleop: '#66bb6a',
  endgame: '#ffb300',
};

function mkBtn(doc: Document, onClick: (ev: MouseEvent) => void): HTMLButtonElement {
  const b = doc.createElement('button');
  b.style.cssText =
    'border:none;border-radius:10px;cursor:pointer;font-family:inherit;font-weight:800;letter-spacing:0.04em;';
  b.addEventListener('click', onClick);
  return b;
}

/** Build the console DOM once per window. Content is painted by updateConsole().
 *  Handlers read the station from lastState so a window opened before the join
 *  round-trips (no state yet) still targets the right station afterwards. */
function buildConsole(w: Window) {
  if (phaseEl && popupWin === w) return; // already built in this window
  const doc = w.document;
  doc.title = 'Match Window';
  doc.body.innerHTML = ''; // a reused named window may hold stale content
  doc.body.style.cssText =
    'margin:0;background:#111;color:#eee;font-family:system-ui,sans-serif;' +
    'display:flex;flex-direction:column;height:100vh;overflow:hidden;';

  const header = doc.createElement('div');
  header.style.cssText = 'position:relative;text-align:center;padding:10px 12px 2px;';
  phaseEl = doc.createElement('div');
  phaseEl.style.cssText = 'font-size:15px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;';
  timerEl = doc.createElement('div');
  timerEl.style.cssText =
    'font-family:ui-monospace,SFMono-Regular,monospace;font-size:46px;font-weight:700;line-height:1.1;';
  // Sound toggle — tap to mute/unmute this window's match audio.
  muteBtn = doc.createElement('button');
  muteBtn.style.cssText =
    'position:absolute;top:8px;right:10px;border:none;background:transparent;cursor:pointer;' +
    'font-size:20px;line-height:1;padding:4px 6px;border-radius:8px;';
  muteBtn.addEventListener('click', () => togglePopupMuted());
  header.append(phaseEl, timerEl, muteBtn);

  robotsEl = doc.createElement('div');
  robotsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;padding:6px 10px;';

  const main = doc.createElement('div');
  main.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:8px;padding:2px 10px;min-height:0;';

  readyBtn = mkBtn(doc, () => {
    if (!lastState) return;
    // Can't ready up until the host opens the ready check.
    if (!lastState.ready && !lastState.readyRequested) return;
    sendStationReady(lastState.station, !lastState.ready);
  });
  readyBtn.style.flex = '1';
  readyBtn.style.fontSize = '26px';

  astopBtn = mkBtn(doc, () => {
    // Drop focus so a stray Space/Enter (drivers reach for the DS hotkeys in a
    // panic) can't re-activate whichever button was tapped last.
    astopBtn?.blur();
    if (!lastState) return;
    if (lastState.phase === 'created' && lastState.aStop) sendStationClearAStop(lastState.station);
    else if (!lastState.aStop) sendStationSelfAStop(lastState.station);
  });
  astopBtn.style.flex = '2';

  reenableBtn = mkBtn(doc, () => {
    reenableBtn?.blur();
    if (!lastState || lastState.enabled || lastState.disabledBy === 'admin') return;
    sendStationSelfUndisable(lastState.station);
  });
  reenableBtn.style.flex = '1';
  reenableBtn.style.fontSize = '22px';

  estopBtn = mkBtn(doc, ev => {
    // A real tap fires the E-Stop immediately — an E-Stop must never wait, and
    // an admin can clear an accidental one. Blur so the button never holds
    // focus, and ignore keyboard-synthesized clicks (detail === 0): a
    // Space/Enter meant for the Driver Station "clicks" a focused button, and
    // that must not trip the E-Stop.
    estopBtn?.blur();
    if (!lastState || lastState.eStop) return;
    if (ev.detail === 0) return;
    sendStationSelfEStop(lastState.station);
  });
  estopBtn.style.cssText +=
    'flex:0 0 46px;font-size:16px;background:transparent;border:2px solid #f44336;color:#f44336;border-radius:10px;';

  main.append(readyBtn, astopBtn, reenableBtn, estopBtn);

  hintEl = doc.createElement('div');
  hintEl.style.cssText = 'color:#999;font-size:12.5px;line-height:1.45;padding:4px 12px 0;text-align:center;';
  hintEl.textContent =
    'Your robot is field-controlled and disabled until the match starts. Leave the match on your station page to drive freely.';

  footerEl = doc.createElement('label');
  footerEl.style.cssText =
    'display:flex;align-items:center;gap:8px;justify-content:center;padding:6px 12px 10px;color:#bbb;font-size:13px;cursor:pointer;';
  closeBox = doc.createElement('input');
  closeBox.type = 'checkbox';
  closeBox.checked = closeAtStartPref();
  closeBox.addEventListener('change', () => setCloseAtStartPref(!!closeBox?.checked));
  const boxText = doc.createElement('span');
  boxText.textContent = 'Close this window when the match starts';
  footerEl.append(closeBox, boxText);

  doc.body.append(header, robotsEl, main, hintEl, footerEl);
}

function formatTime(phase: MatchPhase, remainingTime: number): string {
  const t = Math.ceil(Math.max(0, remainingTime));
  if (phase === 'countdown') return String(t);
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function refreshConsole() {
  if (lastState) updateConsole(lastState);
}

/** Paint the console from match state. Safe to call on every broadcast. */
function updateConsole(state: ConsoleState) {
  lastState = state;
  if (!popupIsOpen() || !phaseEl || !timerEl || !robotsEl || !readyBtn || !astopBtn || !reenableBtn || !estopBtn)
    return;
  const doc = popupWin!.document;
  const { phase, pausedFrom, readyRequested, ready, aStop, eStop, enabled, disabledBy, robots } = state;

  const setup = phase === 'created';
  // The giant A-Stop is live during countdown/auto and a pause taken during auto
  const astopLive = phase === 'countdown' || phase === 'auto' || (phase === 'paused' && pausedFrom === 'auto');

  phaseEl.textContent = phaseLabels[phase] ?? '';
  phaseEl.style.color = phaseColors[phase] ?? '#eee';
  timerEl.style.display = setup ? 'none' : 'block';
  timerEl.style.color = phaseColors[phase] ?? '#eee';
  if (!setup) timerEl.textContent = formatTime(phase, state.remainingTime);

  // Robots ready strip — hidden while the giant A-Stop needs the room
  robotsEl.style.display = astopLive ? 'none' : 'flex';
  if (!astopLive) {
    robotsEl.innerHTML = '';
    for (const r of robots) {
      const chip = doc.createElement('span');
      chip.textContent = `${r.team ?? '—'} ${r.ready ? '✓' : '·'}`;
      const red = r.alliance === 'red';
      chip.style.cssText =
        'padding:3px 12px;border-radius:999px;font-size:14px;font-weight:600;' +
        `background:${red ? 'rgba(211,47,47,0.22)' : 'rgba(21,101,192,0.25)'};` +
        `border:${r.self ? '2px solid' : '1px solid'} ${red ? '#e57373' : '#64b5f6'};` +
        (r.self ? 'font-weight:800;' : '');
      robotsEl.appendChild(chip);
    }
    if (robots.length === 0) {
      const none = doc.createElement('span');
      none.textContent = 'No robots joined yet';
      none.style.cssText = 'color:#888;font-size:13px;';
      robotsEl.appendChild(none);
    }
  }

  // Ready toggle — setup only. Locked until the host opens the ready check.
  readyBtn.style.display = setup && !eStop ? 'block' : 'none';
  if (setup) {
    const locked = !ready && !readyRequested;
    readyBtn.disabled = locked;
    readyBtn.style.cursor = locked ? 'default' : 'pointer';
    if (locked) {
      readyBtn.textContent = 'WAITING FOR HOST TO OPEN READY';
      readyBtn.style.background = '#333';
      readyBtn.style.border = '2px solid #555';
      readyBtn.style.color = '#999';
    } else {
      readyBtn.textContent = ready ? '✓ READY — tap to un-ready' : 'READY UP';
      readyBtn.style.background = ready ? 'transparent' : '#2e7d32';
      readyBtn.style.border = ready ? '2px solid #66bb6a' : '0';
      readyBtn.style.color = ready ? '#66bb6a' : '#fff';
    }
  }

  // A-Stop — pre-arm during setup, giant during countdown/auto, gone after auto
  astopBtn.style.display = (setup || astopLive) && !eStop ? 'block' : 'none';
  if (setup) {
    astopBtn.style.fontSize = '18px';
    astopBtn.style.flex = '0 0 52px';
    astopBtn.disabled = false;
    astopBtn.style.cursor = 'pointer';
    if (aStop) {
      astopBtn.textContent = 'A-STOP ARMED — sits out auto · tap to cancel';
      astopBtn.style.background = '#ffb300';
      astopBtn.style.border = '0';
      astopBtn.style.color = '#000';
    } else {
      astopBtn.textContent = 'ARM A-STOP — sit out auto';
      astopBtn.style.background = 'transparent';
      astopBtn.style.border = '2px solid #ffb300';
      astopBtn.style.color = '#ffb300';
    }
  } else if (astopLive) {
    astopBtn.style.flex = '2';
    astopBtn.style.border = '0';
    if (aStop) {
      astopBtn.textContent = 'A-STOPPED — until teleop';
      astopBtn.disabled = true;
      astopBtn.style.background = '#555';
      astopBtn.style.color = '#ffb300';
      astopBtn.style.fontSize = '7vmin';
      astopBtn.style.cursor = 'default';
    } else {
      astopBtn.textContent = 'A-STOP';
      astopBtn.disabled = false;
      astopBtn.style.background = '#ffb300';
      astopBtn.style.color = '#000';
      astopBtn.style.fontSize = '15vmin';
      astopBtn.style.cursor = 'pointer';
    }
  }

  // Re-enable — the recovery path after an accidental disable (console button
  // or DS Enter key) or a staff-cleared e-stop. Only shown while robots run.
  const robotsRunning = phase === 'auto' || phase === 'teleop' || phase === 'endgame';
  const showReenable = robotsRunning && !enabled && !eStop && !aStop;
  reenableBtn.style.display = showReenable ? 'block' : 'none';
  if (showReenable) {
    if (disabledBy === 'admin') {
      reenableBtn.textContent = 'DISABLED BY FIELD STAFF';
      reenableBtn.disabled = true;
      reenableBtn.style.background = '#333';
      reenableBtn.style.border = '2px solid #777';
      reenableBtn.style.color = '#aaa';
      reenableBtn.style.cursor = 'default';
    } else {
      reenableBtn.textContent = 'RE-ENABLE ROBOT';
      reenableBtn.disabled = false;
      reenableBtn.style.background = '#2e7d32';
      reenableBtn.style.border = '0';
      reenableBtn.style.color = '#fff';
      reenableBtn.style.cursor = 'pointer';
    }
  }

  // E-Stop — always present, fires on the first tap, latched once tripped
  if (eStop) {
    estopBtn.textContent = 'E-STOPPED — see field staff to clear';
    estopBtn.disabled = true;
    estopBtn.style.background = '#b71c1c';
    estopBtn.style.border = 'none';
    estopBtn.style.color = '#fff';
    estopBtn.style.cursor = 'default';
    estopBtn.style.flex = '1';
    estopBtn.style.fontSize = '22px';
  } else {
    estopBtn.textContent = 'E-STOP';
    estopBtn.disabled = false;
    estopBtn.style.background = 'transparent';
    estopBtn.style.border = '2px solid #f44336';
    estopBtn.style.color = '#f44336';
    estopBtn.style.cursor = 'pointer';
    estopBtn.style.flex = '0 0 46px';
    estopBtn.style.fontSize = '16px';
  }

  if (hintEl) hintEl.style.display = setup ? 'block' : 'none';
  if (footerEl) footerEl.style.display = setup ? 'flex' : 'none';
  if (closeBox) closeBox.checked = closeAtStartPref();
  if (muteBtn) {
    muteBtn.textContent = popupMuted ? '🔇' : '🔊';
    muteBtn.style.opacity = popupMuted ? '0.55' : '1';
  }
}

function consoleStateFrom(match: MatchState, station: StationName): ConsoleState {
  const my = match.stationStates[station];
  const robots: ConsoleRobot[] = (Object.entries(match.stationStates) as [StationName, typeof my][])
    .filter(([, s]) => s?.joined)
    .map(([name, s]) => ({
      team: s?.teamNumber ?? null,
      alliance: s?.alliance ?? null,
      ready: s?.ready ?? false,
      self: name === station,
    }));
  return {
    station,
    phase: match.phase,
    pausedFrom: match.pausedFrom,
    remainingTime: match.remainingTime,
    readyRequested: match.readyRequested,
    ready: my?.ready ?? false,
    aStop: my?.aStop ?? false,
    eStop: my?.eStop ?? false,
    enabled: my?.enabled ?? false,
    disabledBy: my?.disabledBy ?? null,
    robots,
  };
}

/** Call from the Join button's own onClick — the click gesture guarantees the
 *  window opens even without pop-up permission. */
export function openMatchPopup() {
  const w = ensureWindow();
  if (!w) return;
  buildConsole(w);
  // First paint happens when the join round-trips and match state arrives
  if (phaseEl) {
    phaseEl.textContent = 'Joining…';
    phaseEl.style.color = '#4fc3f7';
  }
}

export function AStopPopout({ station }: { station: StationName }) {
  const matchState = useMatchState();
  const [isOpen, setIsOpen] = useState(popupIsOpen);
  const [blocked, setBlocked] = useState(false);
  const [muted, setMuted] = useState(popupMuted);

  // Track the module-level mute toggle (flipped from the pop-out window's DOM).
  useEffect(() => {
    const update = () => setMuted(popupMuted);
    mutedSubs.add(update);
    return () => {
      mutedSubs.delete(update);
    };
  }, []);

  const phase = matchState?.phase ?? 'idle';
  const joined = matchState?.stationStates[station]?.joined ?? false;

  // Play match audio for the driver, unless muted. Scoped to the open pop-out
  // window serving THIS station so it's the station's only audio source
  // (station pages don't mount MatchAudioBridge) and never echoes on overview
  // pages that render an AStopPopout per station.
  const audioEnabled = isOpen && !muted && lastState?.station === station;
  useMatchAudio(matchState?.phase, matchState?.endReason, matchState?.matchId, audioEnabled, matchState?.resumeAt);

  // Window lives from join (setup) through the match; closes at post-match,
  // on leave, and — if the box is ticked — at the countdown.
  const desired: 'closed' | PopupMode = !joined
    ? 'closed'
    : phase === 'created'
      ? 'setup'
      : phase === 'countdown' ||
          phase === 'auto' ||
          phase === 'autoPause' ||
          phase === 'paused' ||
          phase === 'teleop' ||
          phase === 'endgame'
        ? closeAtStartPref()
          ? 'closed'
          : 'match'
        : 'closed';

  // Drive the window's lifecycle and content from match state
  useEffect(() => {
    if (desired === 'closed') {
      closePopup();
      setIsOpen(false);
      return;
    }
    let w = popupIsOpen() ? popupWin : null;
    if (!w && desired === 'match' && phase === 'countdown') {
      // Auto-open at the countdown. Permission-free when the setup window from
      // Join is still open (named-window reuse); a fresh open needs pop-up
      // permission — when blocked, the inline buttons on the page still work.
      w = ensureWindow();
      if (!w) setBlocked(true);
    }
    if (!w) {
      setIsOpen(false);
      return;
    }
    buildConsole(w);
    if (matchState) updateConsole(consoleStateFrom(matchState, station));
    setIsOpen(true);
    setBlocked(false);
  }, [desired, phase, station, matchState]);

  // Notice manual closes; also reap a stray setup window when the join it was
  // opened for never landed (e.g. alliance full) — with a grace period so the
  // window opened by the Join click isn't closed before the join round-trips.
  useEffect(() => {
    const iv = setInterval(() => {
      if (desired === 'closed' && popupIsOpen() && Date.now() - popupOpenedAt > 5_000) closePopup();
      const open = popupIsOpen();
      setIsOpen(prev => (prev === open ? prev : open));
    }, 1000);
    return () => clearInterval(iv);
  }, [desired]);

  // Close on unmount — an orphaned window has nothing driving it
  useEffect(() => closePopup, []);

  if (isOpen || desired === 'closed') return null;

  const reopen = () => {
    const w = ensureWindow();
    if (!w) {
      setBlocked(true);
      return;
    }
    buildConsole(w);
    if (matchState) updateConsole(consoleStateFrom(matchState, station));
    setIsOpen(true);
    setBlocked(false);
  };

  const astopPhase = phase === 'countdown' || phase === 'auto';
  return (
    <>
      <Button variant="outlined" color={astopPhase ? 'warning' : 'info'} size="small" onClick={reopen}>
        {astopPhase ? 'Pop Out A-Stop' : 'Pop Out Match Window'}
      </Button>
      {blocked && (
        <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
          <Box component="span" fontWeight={700}>
            Pop-up blocked.
          </Box>{' '}
          Keep the match window from Join open, or allow pop-ups for this site, and the A-Stop window will appear by
          itself when the match starts.
        </Typography>
      )}
    </>
  );
}
