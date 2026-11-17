import { describe, expect, test } from 'bun:test';
import { describeReconfigureChanges } from './reconfigureChanges';

describe('the lines a reconfigure shows teams', () => {
  test('joins first, then moves, then leaves', () => {
    const lines = describeReconfigureChanges([
      { station: 'slot1', from: '254' },
      { station: 'slot2', from: '1678', to: '1234-beta' },
      { station: 'slot3', from: '971', to: '118' },
      { station: 'slot4', from: '118', to: '971' },
    ]);
    expect(lines.map(l => [l.kind, l.text])).toEqual([
      ['join', '1234-beta joins the field'],
      ['move', '118 changes station'],
      ['move', '971 changes station'],
      ['leave', '254 leaves the field'],
      ['leave', '1678 leaves the field'],
    ]);
    expect(lines[0].team).toBe(1234);
  });

  test('nothing changing is no lines', () => {
    expect(describeReconfigureChanges([])).toEqual([]);
  });
});
