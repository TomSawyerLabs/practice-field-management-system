import { describe, expect, test } from 'bun:test';
import { teamNumbersIn } from './slackBridge.js';

describe('teamNumbersIn', () => {
  test('reads the pfms-support naming conventions', () => {
    expect([...teamNumbersIn(['Mark 5940'])]).toEqual([5940]);
    expect([...teamNumbersIn([undefined, 'Aidan Honnold (5940)'])]).toEqual([5940]);
    expect([...teamNumbersIn(['Stephan Massalt (971/9584)'])].sort((a, b) => a - b)).toEqual([971, 9584]);
    expect([...teamNumbersIn(['Leonard Speiser (971, 9584)'])].sort((a, b) => a - b)).toEqual([971, 9584]);
    expect([...teamNumbersIn(['Christina Lee (Team 6036)', 'Christina Lee (Team 6036)'])]).toEqual([6036]);
    expect([...teamNumbersIn(['justin (FRC 8033x9400)'])].sort((a, b) => a - b)).toEqual([8033, 9400]);
    expect([...teamNumbersIn(['Douglas McCluer  114'])]).toEqual([114]);
  });
  test('ignores things that are not team numbers', () => {
    expect(teamNumbersIn(['Cameron Tacklind', 'Cofounder TWILL Technology Inc.']).size).toBe(0);
    expect(teamNumbersIn(['818408']).size).toBe(0); // six digits: a student id, not a team
    expect(teamNumbersIn(['Team 0']).size).toBe(0);
  });
});
