import { describe, expect, test } from 'bun:test';
import { categorize, formatAnnouncement, type DeployCommit } from './deployAnnouncer.js';

const commit = (subject: string, files: string[], trailer?: string): DeployCommit => ({ subject, files, trailer });

describe('categorize', () => {
  test('an explicit Changelog trailer wins over everything else', () => {
    expect(categorize(commit('Fix the thing', ['src/index.ts'], 'feature'))).toBe('feature');
    expect(categorize(commit('Add a thing', ['plans/x.md'], 'Fix'))).toBe('fix');
  });

  test('an unknown trailer value is ignored', () => {
    expect(categorize(commit('Plan: notes', ['plans/x.md'], 'misc'))).toBe('internal');
  });

  test('plan-only, test-only and tooling-only commits are internal', () => {
    expect(categorize(commit('Plan: cast timeline', ['plans/cast.md']))).toBe('internal');
    expect(categorize(commit('Cover the checks with tests', ['src/teamChecker.test.ts']))).toBe('internal');
    expect(categorize(commit('Tighten hooks', ['lefthook.yml', 'CLAUDE.md']))).toBe('internal');
  });

  test('a "Plan:" subject is internal even with no file list', () => {
    expect(categorize(commit('Plan: both sides deployed', []))).toBe('internal');
  });

  test('docs, with or without plan notes, are docs', () => {
    expect(categorize(commit('Explain VLANs', ['docs/network.md']))).toBe('docs');
    expect(categorize(commit('Explain VLANs', ['docs/network.md', 'README.md', 'plans/x.md']))).toBe('docs');
  });

  test('code changes are fixes when the subject says so, features otherwise', () => {
    expect(categorize(commit('Battery charts no longer dive to 0', ['src/fmsServer.ts']))).toBe('fix');
    expect(categorize(commit('Match recording actually records', ['src/matchRecorder.ts']))).toBe('fix');
    expect(categorize(commit('Add SystemCore support', ['src/teamChecker.ts', 'docs/x.md']))).toBe('feature');
  });
});

describe('formatAnnouncement', () => {
  const last = 'aaaaaaaaaa';
  const current = 'bbbbbbbbbb';

  test('groups user-facing changes first, then fixes, then docs, and leaves out internal ones', () => {
    const text = formatAnnouncement(
      [
        commit('Plan: notes', ['plans/x.md']),
        commit('Docs for the thing', ['docs/x.md']),
        commit('Charts no longer dive', ['src/a.ts']),
        commit('SystemCore support', ['src/b.ts']),
      ],
      last,
      current,
    );
    expect(text).toBe(
      [
        ':rocket: *pFMS updated* — 3 changes (`aaaaaaa` → `bbbbbbb`)',
        '',
        "*What's new*",
        '• SystemCore support',
        '',
        '*Fixes*',
        '• Charts no longer dive',
        '',
        '*Docs*',
        '• Docs for the thing',
      ].join('\n'),
    );
  });

  test('internal changes are shown when there is nothing else to say', () => {
    const text = formatAnnouncement([commit('Plan: notes', ['plans/x.md'])], last, current);
    expect(text).toContain('*Behind the scenes*');
    expect(text).toContain('• Plan: notes');
    expect(text).toContain('1 change ');
  });

  test('caps the list, filling the most important groups first', () => {
    const features = Array.from({ length: 14 }, (_, i) => commit(`Feature ${i}`, ['src/a.ts']));
    const fixes = Array.from({ length: 3 }, (_, i) => commit(`Crash ${i} fixed`, ['src/a.ts']));
    const text = formatAnnouncement([...fixes, ...features], last, current);
    expect(text).toContain('• Feature 13');
    expect(text).toContain('• Crash 0 fixed');
    expect(text).not.toContain('• Crash 1 fixed');
    expect(text).toContain('…and 2 more (2 fixes)');
    expect(text).toContain('17 changes');
  });

  test('when one group fills the list, the overflow line names every group that was cut', () => {
    const features = Array.from({ length: 16 }, (_, i) => commit(`Feature ${i}`, ['src/a.ts']));
    const text = formatAnnouncement(
      [...features, commit('Crash fixed', ['src/a.ts']), commit('Docs', ['docs/x.md'])],
      last,
      current,
    );
    expect(text).not.toContain('*Fixes*');
    expect(text).toContain('…and 3 more (1 new, 1 fix, 1 doc update)');
  });

  test('with no commit list it still says what version is running', () => {
    expect(formatAnnouncement([], last, current)).toBe(':rocket: *pFMS updated* to `bbbbbbb` (was `aaaaaaa`).');
  });
});
