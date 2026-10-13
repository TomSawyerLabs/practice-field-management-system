import { describe, expect, test } from 'bun:test';
import { autoInstallDue, inWindow } from './updateManager.js';

const at = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00`); // local time
const min = 60_000;
const build = { version: 'abc1234' };

describe('the daily update window', () => {
  test('a same-day window includes its start, not its end', () => {
    expect(inWindow(at('03:00'), '03:00', '05:00')).toBe(true);
    expect(inWindow(at('04:59'), '03:00', '05:00')).toBe(true);
    expect(inWindow(at('05:00'), '03:00', '05:00')).toBe(false);
    expect(inWindow(at('02:59'), '03:00', '05:00')).toBe(false);
  });

  test('a window can cross midnight', () => {
    expect(inWindow(at('23:30'), '22:00', '02:00')).toBe(true);
    expect(inWindow(at('01:00'), '22:00', '02:00')).toBe(true);
    expect(inWindow(at('12:00'), '22:00', '02:00')).toBe(false);
  });
});

describe('when an automatic update installs', () => {
  test('never with the policy off or notify-only', () => {
    expect(autoInstallDue(undefined, at('04:00'), 999 * min, build, [])).toBe(false);
    expect(autoInstallDue({ mode: 'off' }, at('04:00'), 999 * min, build, [])).toBe(false);
    expect(autoInstallDue({ mode: 'notify' }, at('04:00'), 999 * min, build, [])).toBe(false);
  });

  test('window: inside it, once the field has been idle long enough', () => {
    const policy = { mode: 'window' as const, windowStart: '03:00', windowEnd: '05:00', idleMinutes: 30 };
    expect(autoInstallDue(policy, at('04:00'), 31 * min, build, [])).toBe(true);
    expect(autoInstallDue(policy, at('04:00'), 10 * min, build, [])).toBe(false);
    expect(autoInstallDue(policy, at('14:00'), 999 * min, build, [])).toBe(false);
  });

  test('window defaults to 03:00–05:00 and 30 idle minutes', () => {
    expect(autoInstallDue({ mode: 'window' }, at('03:30'), 30 * min, build, [])).toBe(true);
    expect(autoInstallDue({ mode: 'window' }, at('05:30'), 30 * min, build, [])).toBe(false);
    expect(autoInstallDue({ mode: 'window' }, at('03:30'), 29 * min, build, [])).toBe(false);
  });

  test('idle: any time the field has been idle long enough', () => {
    expect(autoInstallDue({ mode: 'idle', idleMinutes: 5 }, at('14:00'), 6 * min, build, [])).toBe(true);
    expect(autoInstallDue({ mode: 'idle', idleMinutes: 5 }, at('14:00'), 4 * min, build, [])).toBe(false);
  });

  test('never while the field is in use, with nothing to install, or for a build that failed here', () => {
    expect(autoInstallDue({ mode: 'idle' }, at('14:00'), null, build, [])).toBe(false);
    expect(autoInstallDue({ mode: 'idle' }, at('14:00'), 999 * min, null, [])).toBe(false);
    expect(autoInstallDue({ mode: 'idle' }, at('14:00'), 999 * min, build, ['abc1234'])).toBe(false);
  });
});
