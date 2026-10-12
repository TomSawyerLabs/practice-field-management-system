import { describe, expect, test } from 'bun:test';
import { answerFor, PendingQueries, stationScope, withDnsId, withoutUnicastResponse } from './mdnsReflector.js';

/**
 * The reflector's answer routing: a question forwarded to a VLAN is remembered
 * for a few seconds, and the VLAN's answer goes only to the laptop(s) with
 * that question open. This is what stops six radios all named `radio.local`
 * from fighting over every laptop's cache.
 */

const laptopA = { address: '10.55.0.20', port: 5353, id: 0 };
const laptopB = { address: '10.55.0.21', port: 5353, id: 0 };

describe('open questions', () => {
  test('an answer goes to the laptop that asked, on the VLAN it was asked of', () => {
    const q = new PendingQueries();
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_000);
    q.add(['radio.local'], stationScope('slot4'), laptopB, 1_000);
    expect(q.match(['radio.local'], stationScope('slot1'), 1_100)).toEqual([laptopA]);
    expect(q.match(['radio.local'], stationScope('slot4'), 1_100)).toEqual([laptopB]);
  });

  test('an answer nobody asked for goes nowhere', () => {
    const q = new PendingQueries();
    q.add(['roborio-1234-frc.local'], stationScope('slot1'), laptopA, 1_000);
    expect(q.match(['radio.local'], stationScope('slot1'), 1_100)).toEqual([]);
    expect(q.match(['roborio-1234-frc.local'], stationScope('slot4'), 1_100)).toEqual([]);
  });

  test('names match case-insensitively and with or without the trailing dot', () => {
    const q = new PendingQueries();
    q.add(['RoboRIO-1234-FRC.local.'], stationScope('slot1'), laptopA, 1_000);
    expect(q.match(['roborio-1234-frc.local'], stationScope('slot1'), 1_100)).toEqual([laptopA]);
  });

  test('a question ages out after the TTL', () => {
    const q = new PendingQueries(3_000);
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_000);
    expect(q.match(['radio.local'], stationScope('slot1'), 3_999)).toEqual([laptopA]);
    expect(q.match(['radio.local'], stationScope('slot1'), 4_000)).toEqual([]);
    expect(q.size).toBe(0);
  });

  test('a laptop asking again does not stack, and two laptops both get the answer', () => {
    const q = new PendingQueries();
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_000);
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_500);
    q.add(['radio.local'], stationScope('slot1'), laptopB, 1_500);
    expect(q.size).toBe(2);
    expect(q.match(['radio.local'], stationScope('slot1'), 1_600)).toEqual([laptopA, laptopB]);
  });

  test('a multi-name answer reaches each asker once', () => {
    const q = new PendingQueries();
    q.add(['_ni-rt._tcp.local', 'roborio-1234-frc.local'], stationScope('slot1'), laptopA, 1_000);
    expect(q.match(['_ni-rt._tcp.local', 'roborio-1234-frc.local'], stationScope('slot1'), 1_100)).toEqual([laptopA]);
  });

  test("two robots of one team: each station's answer goes to the laptop that asked through it", () => {
    // Both robots answer `limelight.local`; the station the question went to
    // says whose answer is whose, not the team number.
    const q = new PendingQueries();
    q.add(['limelight.local'], stationScope('slot1'), laptopA, 1_000);
    q.add(['limelight.local'], stationScope('slot2'), laptopB, 1_000);
    expect(q.match(['limelight.local'], stationScope('slot1'), 1_100)).toEqual([laptopA]);
    expect(q.match(['limelight.local'], stationScope('slot2'), 1_100)).toEqual([laptopB]);
  });

  test('prune drops aged entries without touching live ones', () => {
    const q = new PendingQueries(3_000);
    q.add(['radio.local'], stationScope('slot1'), laptopA, 1_000);
    q.add(['radio.local'], stationScope('slot1'), laptopB, 3_000);
    q.prune(4_500);
    expect(q.match(['radio.local'], stationScope('slot1'), 4_500)).toEqual([laptopB]);
  });
});

describe('legacy one-shot queriers', () => {
  test('the answer carries the ID the querier sent', () => {
    const response = Buffer.alloc(12);
    response.writeUInt16BE(0x8400, 2);
    const patched = withDnsId(response, 0xbeef);
    expect(patched.readUInt16BE(0)).toBe(0xbeef);
    expect(patched.readUInt16BE(2)).toBe(0x8400);
    expect(response.readUInt16BE(0)).toBe(0); // original untouched
  });
});

describe('forwarded queries', () => {
  /** A query for `names`, each question with the QU bit set. */
  function quQuery(names: string[]): Buffer {
    const parts = [Buffer.from([0, 0, 0, 0, 0, names.length, 0, 0, 0, 0, 0, 0])];
    for (const name of names) {
      for (const label of name.split('.')) parts.push(Buffer.from([label.length]), Buffer.from(label));
      parts.push(Buffer.from([0, 0, 1, 0x80, 1])); // end of name, A, class IN | QU
    }
    return Buffer.concat(parts);
  }

  test('ask for multicast answers: the QU bit is cleared in every question', () => {
    const query = quQuery(['limelight-front.local', 'radio.local']);
    const out = withoutUnicastResponse(query);
    const classes: number[] = [];
    for (let i = 0; i < out.length - 1; i++)
      if (out[i] === 0 && out[i + 1] === 0 && out[i + 2] === 1) classes.push(out.readUInt16BE(i + 3));
    expect(classes).toEqual([1, 1]);
    expect(query.readUInt16BE(query.length - 2)).toBe(0x8001); // original untouched
  });

  test('a truncated question section is left alone rather than misread', () => {
    const query = quQuery(['radio.local']).subarray(0, 16);
    expect(withoutUnicastResponse(query).equals(query)).toBe(true);
  });

  test('answers carry the ID each laptop expects', () => {
    const response = Buffer.alloc(12);
    response.writeUInt16BE(0x1234, 0);
    expect(answerFor(response, { address: '10.55.0.20', port: 5353, id: 0x1234 }).readUInt16BE(0)).toBe(0);
    expect(answerFor(response, { address: '10.55.0.21', port: 50123, id: 0x1234 })).toBe(response);
  });
});
