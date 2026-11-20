/**
 * Which robot camera, if any, the scoreboard TVs (the main display) show over
 * the scoreboard. Staff turn it on and off on the fly (`mainDisplayCameraSet`,
 * from the Network page's Watch view). The TVs watch it through the camera
 * relay (src/cameraRelay.ts) like any other viewer: live when the robot's
 * radio has no bandwidth limit, stills otherwise. It comes down by itself when
 * that team leaves the station.
 */
import type { CameraVerdict } from './cameraRelayApi.js';
import type { MainDisplayCamera, MainDisplayCameraSet, MainDisplayCameraState, StationName } from './types.js';

export interface MainDisplayCameraDeps {
  verdict: (station: StationName, ip: string, port: number) => CameraVerdict;
  teamFor: (station: StationName) => number | null;
  broadcast: (state: MainDisplayCameraState) => void;
  now?: () => number;
}

export class MainDisplayCameraControl {
  private camera: MainDisplayCamera | null = null;

  constructor(private deps: MainDisplayCameraDeps) {}

  getState(): MainDisplayCameraState {
    return { type: 'mainDisplayCamera', camera: this.camera };
  }

  /** Put a camera up, or take it down. Returns why not, or null. */
  set(request: MainDisplayCameraSet['camera'], who: string): string | null {
    if (!request) {
      if (this.camera) console.log(`Main display camera taken down by ${who}`);
      this.update(null);
      return null;
    }
    const { station, ip, port } = request;
    const verdict = this.deps.verdict(station, ip, port);
    if (!verdict.ok) return verdict.error;
    const team = this.deps.teamFor(station);
    if (team === null) return 'No robot on that station';
    console.log(`Main display camera: team ${team} ${ip}:${port} on ${station}, by ${who}`);
    this.update({ station, team, ip, port, since: (this.deps.now ?? Date.now)() });
    return null;
  }

  /** Take the camera down if its team has left the station. Call it often. */
  check(): void {
    if (this.camera && this.deps.teamFor(this.camera.station) !== this.camera.team) {
      console.log(`Main display camera taken down: team ${this.camera.team} left ${this.camera.station}`);
      this.update(null);
    }
  }

  private update(camera: MainDisplayCamera | null): void {
    if (camera === null && this.camera === null) return;
    this.camera = camera;
    this.deps.broadcast(this.getState());
  }
}
