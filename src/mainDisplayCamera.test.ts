import { describe, expect, spyOn, test } from 'bun:test';
import { MainDisplayCameraControl } from './mainDisplayCamera.js';
import type { CameraVerdict } from './cameraRelayApi.js';
import type { MainDisplayCameraState, StationName } from './types.js';

function setup(verdict: CameraVerdict = { ok: true, key: { ifname: 'br-slot1', ip: '10.28.54.2', port: 1181 } }) {
  spyOn(console, 'log').mockImplementation(() => {});
  const teams: Partial<Record<StationName, number>> = { slot1: 2854 };
  const sent: MainDisplayCameraState[] = [];
  const control = new MainDisplayCameraControl({
    verdict: () => verdict,
    teamFor: s => teams[s] ?? null,
    broadcast: s => void sent.push(s),
    now: () => 1000,
  });
  return { control, teams, sent };
}

const cam = { station: 'slot1' as const, ip: '10.28.54.2', port: 1181 };

describe('main display camera', () => {
  test('staff put a camera up and take it down; every display hears both', () => {
    const { control, sent } = setup();
    expect(control.set(cam, '10.255.0.77')).toBeNull();
    expect(control.set(null, '10.255.0.77')).toBeNull();
    expect(sent).toEqual([
      { type: 'mainDisplayCamera', camera: { ...cam, team: 2854, since: 1000 } },
      { type: 'mainDisplayCamera', camera: null },
    ]);
    // Taking down nothing tells nobody
    control.set(null, 'x');
    expect(sent.length).toBe(2);
  });

  test('a camera the relay would refuse is not put up', () => {
    const { control, sent } = setup({ ok: false, status: 404, error: "pFMS hasn't found a camera stream there" });
    expect(control.set(cam, 'x')).toBe("pFMS hasn't found a camera stream there");
    expect(sent).toEqual([]);
  });

  test('a camera on a robot with a bandwidth limit goes up anyway (the TVs get stills)', () => {
    const { control } = setup({
      ok: true,
      key: { ifname: 'br-slot1', ip: '10.28.54.2', port: 1181 },
      stillsOnly: 'limit',
    });
    expect(control.set(cam, 'x')).toBeNull();
    expect(control.getState().camera?.team).toBe(2854);
  });

  test('it comes down by itself when the team leaves the station', () => {
    const { control, teams, sent } = setup();
    control.set(cam, 'x');
    control.check();
    expect(sent.length).toBe(1);
    teams.slot1 = 1700;
    control.check();
    expect(control.getState().camera).toBeNull();
    expect(sent.at(-1)).toEqual({ type: 'mainDisplayCamera', camera: null });
  });
});
