import { describe, expect, test } from 'bun:test';
import { MatchEngine } from './matchEngine.js';
import { CHALLENGE_MAX_DURATION, CHALLENGE_MIN_DURATION, type MatchConfig } from './types.js';

/** A client asking for a config. Durations are only honoured for a challenge. */
function request(over: Partial<MatchConfig>): MatchConfig {
  return { autoDuration: 20, teleopDuration: 140, endgameDuration: 30, pauseDuration: 3, ...over };
}

function created(): MatchEngine {
  const engine = new MatchEngine();
  engine.createMatch();
  return engine;
}

describe('official match timing stays locked', () => {
  test('durations sent by a client are ignored', () => {
    const engine = created();
    engine.updateMatchConfig(request({ autoDuration: 5, teleopDuration: 42, endgameDuration: 1, pauseDuration: 0 }));
    const { config } = engine.getState();
    expect(config.autoDuration).toBe(20);
    expect(config.teleopDuration).toBe(140);
    expect(config.endgameDuration).toBe(30);
    expect(config.pauseDuration).toBe(3);
    expect(config.format ?? 'official').toBe('official');
  });

  test('skipAuto and autoWinner still come through', () => {
    const engine = created();
    engine.updateMatchConfig(request({ skipAuto: true, autoWinner: 'blue' }));
    const { config } = engine.getState();
    expect(config.skipAuto).toBe(true);
    expect(config.autoWinner).toBe('blue');
  });
});

describe('challenge format', () => {
  test('unlocks the window and zeroes everything else', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 45 }));
    const { config } = engine.getState();
    expect(config.format).toBe('challenge');
    expect(config.teleopDuration).toBe(45);
    expect(config.autoDuration).toBe(0);
    expect(config.pauseDuration).toBe(0);
    expect(config.endgameDuration).toBe(0);
    expect(config.skipAuto).toBe(true);
    expect(config.challengeTiming).toBe('window');
  });

  test('clamps a window that would strand the field', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 100_000 }));
    expect(engine.getState().config.teleopDuration).toBe(CHALLENGE_MAX_DURATION);

    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 0 }));
    expect(engine.getState().config.teleopDuration).toBe(CHALLENGE_MIN_DURATION);
  });

  test('stopwatch timing is carried', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', challengeTiming: 'stopwatch' }));
    expect(engine.getState().config.challengeTiming).toBe('stopwatch');
  });

  test('reports no sub-period and no inactive goal', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 60 }));
    const state = engine.getState();
    expect(state.subPeriod).toBeNull();
    expect(state.inactiveGoalAlliance).toBeNull();
  });

  test('the format carries over to the next run, the rest resets', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 90, challengeTiming: 'stopwatch' }));
    engine.cancelMatch();
    engine.createMatch();
    const { config } = engine.getState();
    expect(config.format).toBe('challenge');
    expect(config.teleopDuration).toBe(90);
    expect(config.challengeTiming).toBe('stopwatch');
  });

  test('switching back to official restores official timing', () => {
    const engine = created();
    engine.updateMatchConfig(request({ format: 'challenge', teleopDuration: 90 }));
    engine.updateMatchConfig(request({ format: 'official' }));
    const { config } = engine.getState();
    expect(config.format ?? 'official').toBe('official');
    expect(config.teleopDuration).toBe(140);
    expect(config.autoDuration).toBe(20);
  });

  test('a created match starts official until a host asks otherwise', () => {
    const engine = created();
    expect(engine.getState().config.teleopDuration).toBe(140);
  });
});
