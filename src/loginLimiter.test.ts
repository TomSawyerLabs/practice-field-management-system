import { describe, expect, test } from 'bun:test';
import { LoginLimiter } from './loginLimiter.js';

describe('LoginLimiter', () => {
  let time = 0;
  const limiter = () => {
    time = 1_000_000;
    return new LoginLimiter(() => time);
  };

  test('five tries a minute from one address', () => {
    const limit = limiter();
    for (let i = 0; i < 5; i++) expect(limit.take('203.0.113.7')).toBeNull();
    expect(limit.take('203.0.113.7')).toBe(60_000);
    expect(limit.take('203.0.113.8')).toBeNull();
  });

  test('the wait runs from the oldest try', () => {
    const limit = limiter();
    for (let i = 0; i < 5; i++) limit.take('203.0.113.7');
    time += 45_000;
    expect(limit.take('203.0.113.7')).toBe(15_000);
    time += 15_000;
    expect(limit.take('203.0.113.7')).toBeNull();
  });

  test('thirty tries a minute overall, across addresses', () => {
    const limit = limiter();
    for (let i = 0; i < 30; i++) expect(limit.take(`203.0.113.${i}`)).toBeNull();
    expect(limit.take('198.51.100.1')).toBe(60_000);
  });

  test('a refused try is not counted', () => {
    const limit = limiter();
    for (let i = 0; i < 5; i++) limit.take('203.0.113.7');
    time += 30_000;
    for (let i = 0; i < 40; i++) limit.take('203.0.113.7');
    time += 30_000;
    expect(limit.take('203.0.113.7')).toBeNull();
  });

  test('a good login clears its own address, not the overall count', () => {
    const limit = limiter();
    for (let i = 0; i < 5; i++) limit.take('203.0.113.7');
    limit.clear('203.0.113.7');
    expect(limit.take('203.0.113.7')).toBeNull();
    for (let i = 0; i < 24; i++) limit.take(`198.51.100.${i}`);
    expect(limit.take('192.0.2.1')).toBeGreaterThan(0);
  });
});
