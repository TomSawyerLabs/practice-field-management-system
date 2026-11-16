import { describe, expect, test } from 'bun:test';
import { safeReturnUrl } from './teamReturnUrl.js';

const own = 'http://pfms.tsl';

describe('safeReturnUrl', () => {
  test("goes back to the team's own robots", () => {
    expect(safeReturnUrl(1234, 'http://10.12.34.2:5800/dash?x=1', own)).toBe('http://10.12.34.2:5800/dash?x=1');
    expect(safeReturnUrl(1678, 'http://roboRIO-1678-FRC.local/', own)).toBe('http://roborio-1678-frc.local/');
    expect(safeReturnUrl(5, 'http://10.0.5.2/', own)).toBe('http://10.0.5.2/');
  });

  test("never to another team's robot or another site", () => {
    expect(safeReturnUrl(1234, 'http://10.56.78.2/', own)).toBeNull();
    expect(safeReturnUrl(1234, 'http://roborio-254-frc.local/', own)).toBeNull();
    expect(safeReturnUrl(1234, 'https://evil.example/', own)).toBeNull();
    expect(safeReturnUrl(1234, '//evil.example/', own)).toBeNull();
    expect(safeReturnUrl(1234, 'javascript:alert(1)', own)).toBeNull();
    expect(safeReturnUrl(1234, 'http://user:pw@10.12.34.2/', own)).toBeNull();
  });

  test('or somewhere on pFMS', () => {
    expect(safeReturnUrl(1234, '/1234#network', own)).toBe('http://pfms.tsl/1234#network');
    expect(safeReturnUrl(1234, null, own)).toBeNull();
  });
});
