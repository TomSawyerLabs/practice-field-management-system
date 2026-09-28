import { describe, expect, test } from 'bun:test';
import { teamOfSsid } from './utils.js';

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
