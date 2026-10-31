import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { appError, appWarn } from './appLogger.js';
import { StationNameList, type EStopSource, type StationName } from './types.js';

const DEFAULT_FILE = 'estop-state.json';

/** Every stop that has to outlive this process: a stop that lapses on a
 *  restart hands a Driver Station still set to Enabled its robot back. */
export type SavedStops = {
  /** When the field E-Stop was latched (epoch ms), or null. */
  fieldEStopSince: number | null;
  /** Only stations with something to remember. */
  stations: Partial<Record<StationName, { eStopBy?: EStopSource; teamStopped?: true }>>;
};

const EStopSources: readonly string[] = ['ds', 'team', 'staff'] satisfies EStopSource[];

function parseStops(text: string): SavedStops {
  const raw = JSON.parse(text) as Partial<SavedStops>;
  const stops: SavedStops = {
    fieldEStopSince: typeof raw.fieldEStopSince === 'number' ? raw.fieldEStopSince : null,
    stations: {},
  };
  for (const station of StationNameList) {
    const saved = raw.stations?.[station];
    if (!saved) continue;
    stops.stations[station] = {
      ...(saved.eStopBy && EStopSources.includes(saved.eStopBy) ? { eStopBy: saved.eStopBy } : {}),
      ...(saved.teamStopped ? { teamStopped: true } : {}),
    };
  }
  return stops;
}

/** Every station a saved stop may still be cutting. A field E-Stop covers them
 *  all: which ones have a robot is only known once the engine has looked. */
export function stationsCutAtStart(stops: SavedStops | null): StationName[] {
  if (!stops) return [];
  if (stops.fieldEStopSince !== null) return [...StationNameList];
  return StationNameList.filter(s => stops.stations[s]);
}

/**
 * The stops on disk. Synced and renamed into place on every change, because a
 * press has to survive a crash a moment later. A press that can't be saved
 * still stops the robot; it just won't outlive this process, so it's said loudly.
 */
export class StopStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env.ESTOP_STATE_FILE ?? DEFAULT_FILE;
  }

  /** What the last run left. Null with nothing there; a file that can't be
   *  read is said out loud, because a stop may have been lost with it. */
  load(): SavedStops | null {
    let text: string;
    try {
      text = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        appError(`Could not read ${this.filePath}, so any saved e-stops are lost: ${(err as Error).message}`);
      }
      return null;
    }
    try {
      return parseStops(text);
    } catch (err) {
      appError(`${this.filePath} is unreadable, so any saved e-stops are lost: ${(err as Error).message}`);
      return null;
    }
  }

  save(stops: SavedStops): void {
    const temp = `${this.filePath}.tmp`;
    try {
      const fd = openSync(temp, 'w');
      try {
        writeSync(fd, JSON.stringify(stops, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.filePath);
    } catch (err) {
      appWarn(`Could not save the e-stops to ${this.filePath}, a restart would lift them: ${(err as Error).message}`);
    }
  }
}
