import { describe, expect, test } from 'bun:test';
import { jsonEqual } from './jsonEqual';

describe('jsonEqual', () => {
  test('compares by value', () => {
    expect(jsonEqual({ a: 1, b: [{ c: 'x' }] }, { b: [{ c: 'x' }], a: 1 })).toBe(true);
    expect(jsonEqual(undefined, undefined)).toBe(true);
    expect(jsonEqual(null, null)).toBe(true);
  });

  test('sees any difference', () => {
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
  });

  test('a release (null) is not the same as nothing waiting (undefined)', () => {
    expect(jsonEqual(null, undefined)).toBe(false);
    expect(jsonEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});
