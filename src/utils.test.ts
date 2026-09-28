import { describe, expect, test } from 'bun:test';
import { perKeySerializer, teamOfSsid } from './utils.js';

describe('teamOfSsid', () => {
  test('reads the number before the first hyphen', () => {
    expect(teamOfSsid('1234-Comp')).toBe(1234);
    expect(teamOfSsid('5940')).toBe(5940);
  });
  test('null for nothing, or no leading number', () => {
    expect(teamOfSsid('')).toBeNull();
    expect(teamOfSsid(undefined)).toBeNull();
    expect(teamOfSsid('robot-1234')).toBeNull();
  });
});

describe('perKeySerializer', () => {
  /** A task that records when it starts and ends, and finishes on demand. */
  function gate(log: string[], name: string) {
    let release!: () => void;
    const done = new Promise<void>(r => (release = r));
    const task = async () => {
      log.push(`${name} start`);
      await done;
      log.push(`${name} end`);
      return name;
    };
    return { task, release };
  }

  test('tasks for one key run one after another, in order', async () => {
    const run = perKeySerializer<string>();
    const log: string[] = [];
    const a = gate(log, 'a');
    const b = gate(log, 'b');
    const pa = run('slot1', a.task);
    const pb = run('slot1', b.task);
    await Bun.sleep(0);
    expect(log).toEqual(['a start']); // b waits for a
    a.release();
    await pa;
    await Bun.sleep(0);
    expect(log).toEqual(['a start', 'a end', 'b start']);
    b.release();
    expect(await pb).toBe('b');
  });

  test('different keys do not wait for each other', async () => {
    const run = perKeySerializer<string>();
    const log: string[] = [];
    const a = gate(log, 'a');
    const b = gate(log, 'b');
    const pa = run('slot1', a.task);
    const pb = run('slot2', b.task);
    await Bun.sleep(0);
    expect(log).toEqual(['a start', 'b start']);
    a.release();
    b.release();
    await Promise.all([pa, pb]);
  });

  test('a failing task does not block the next one, and reports its own error', async () => {
    const run = perKeySerializer<string>();
    const failed = run('slot1', async () => {
      throw new Error('iptables exploded');
    });
    const next = run('slot1', async () => 'ok');
    await expect(failed).rejects.toThrow('iptables exploded');
    expect(await next).toBe('ok');
  });
});
