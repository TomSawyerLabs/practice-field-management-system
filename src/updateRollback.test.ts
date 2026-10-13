import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmedState,
  MAX_START_ATTEMPTS,
  restorePreviousBinary,
  revertedState,
  startupDecision,
  type SelfUpdateState,
} from './updateRollback.js';

const now = new Date('2026-10-13T15:00:00Z');
const pending = (attempts: number): SelfUpdateState => ({
  pending: { from: 'old1234', to: 'new5678', attempts, at: '2026-10-13T14:59:00Z' },
});

describe('a start after a self-update', () => {
  test('nothing pending: nothing to do', () => {
    const state: SelfUpdateState = { lastUpdate: { from: 'a', to: 'b', at: 'x' } };
    expect(startupDecision(state, 'b')).toEqual({ state, revert: false, watch: false });
  });

  test('the new build starting is counted and watched', () => {
    const d = startupDecision(pending(0), 'new5678', now);
    expect(d.revert).toBe(false);
    expect(d.watch).toBe(true);
    expect(d.state.pending?.attempts).toBe(1);
  });

  test(`a new build that keeps dying is reverted on start ${MAX_START_ATTEMPTS + 1}`, () => {
    let state = pending(0);
    for (let i = 0; i < MAX_START_ATTEMPTS; i++) {
      const d = startupDecision(state, 'new5678', now);
      expect(d.revert).toBe(false);
      state = d.state;
    }
    const d = startupDecision(state, 'new5678', now);
    expect(d.revert).toBe(true);
    expect(d.state.pending).toBeUndefined();
    expect(d.state.reverted).toMatchObject({ from: 'old1234', to: 'new5678' });
    expect(d.state.skip).toEqual(['new5678']);
  });

  test('a different build starting (the old one, put back) stops the watch', () => {
    const d = startupDecision(pending(1), 'old1234', now);
    expect(d).toMatchObject({ revert: false, watch: false });
    expect(d.state.pending).toBeUndefined();
  });
});

describe('settling a pending update', () => {
  test('confirmed: recorded as the last update, an old revert notice cleared', () => {
    const state = { ...pending(1), reverted: { from: 'x', to: 'y', at: 'z', reason: 'r' } };
    const s = confirmedState(state, now);
    expect(s.pending).toBeUndefined();
    expect(s.reverted).toBeUndefined();
    expect(s.lastUpdate).toEqual({ from: 'old1234', to: 'new5678', at: now.toISOString() });
  });

  test('reverted: the failed build is skipped from then on, once', () => {
    const s = revertedState({ ...pending(1), skip: ['new5678', 'other00'] }, 'it hung', now);
    expect(s.reverted?.reason).toBe('it hung');
    expect(s.skip).toEqual(['new5678', 'other00']);
  });
});

describe('putting the previous binary back', () => {
  test('swaps <exe>.prev in and keeps the failed one as <exe>.failed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pfms-rollback-'));
    const exe = join(dir, 'pfms');
    writeFileSync(exe, 'new');
    writeFileSync(`${exe}.prev`, 'old');
    try {
      expect(restorePreviousBinary(exe)).toBe(true);
      expect(readFileSync(exe, 'utf-8')).toBe('old');
      expect(readFileSync(`${exe}.failed`, 'utf-8')).toBe('new');
      expect(restorePreviousBinary(exe)).toBe(false); // no .prev any more
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
