import { describe, expect, test } from 'bun:test';
import { answerFor, PendingQueries, stationScope, teamScope, withDnsId } from './mdnsReflector.js';
import { stationMdnsIp } from './utils.js';

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
    q.add(['radio.local'], teamScope(1234), laptopA, 1_000);
    q.add(['radio.local'], teamScope(5940), laptopB, 1_000);
    expect(q.match(['radio.local'], teamScope(1234), 1_100)).toEqual([laptopA]);
    expect(q.match(['radio.local'], teamScope(5940), 1_100)).toEqual([laptopB]);
  });

  test('an answer nobody asked for goes nowhere', () => {
    const q = new PendingQueries();
    q.add(['roborio-1234-frc.local'], teamScope(1234), laptopA, 1_000);
    expect(q.match(['radio.local'], teamScope(1234), 1_100)).toEqual([]);
    expect(q.match(['roborio-1234-frc.local'], teamScope(5940), 1_100)).toEqual([]);
  });

  test('names match case-insensitively and with or without the trailing dot', () => {
    const q = new PendingQueries();
    q.add(['RoboRIO-1234-FRC.local.'], teamScope(1234), laptopA, 1_000);
    expect(q.match(['roborio-1234-frc.local'], teamScope(1234), 1_100)).toEqual([laptopA]);
  });

  test('a question ages out after the TTL', () => {
    const q = new PendingQueries(3_000);
    q.add(['radio.local'], teamScope(1234), laptopA, 1_000);
    expect(q.match(['radio.local'], teamScope(1234), 3_999)).toEqual([laptopA]);
    expect(q.match(['radio.local'], teamScope(1234), 4_000)).toEqual([]);
    expect(q.size).toBe(0);
  });

  test('a laptop asking again does not stack, and two laptops both get the answer', () => {
    const q = new PendingQueries();
    q.add(['radio.local'], teamScope(1234), laptopA, 1_000);
    q.add(['radio.local'], teamScope(1234), laptopA, 1_500);
    q.add(['radio.local'], teamScope(1234), laptopB, 1_500);
    expect(q.size).toBe(2);
    expect(q.match(['radio.local'], teamScope(1234), 1_600)).toEqual([laptopA, laptopB]);
  });

  test('a multi-name answer reaches each asker once', () => {
    const q = new PendingQueries();
    q.add(['_ni-rt._tcp.local', 'roborio-1234-frc.local'], teamScope(1234), laptopA, 1_000);
    expect(q.match(['_ni-rt._tcp.local', 'roborio-1234-frc.local'], teamScope(1234), 1_100)).toEqual([laptopA]);
  });

  test("two robots of one team: each station's answer goes to the laptop that asked through it", () => {
    // Both robots answer `limelight.local`; the station's own socket is what
    // tells their answers apart, not the team number.
    const q = new PendingQueries();
    q.add(['limelight.local'], stationScope('slot1'), laptopA, 1_000);
    q.add(['limelight.local'], stationScope('slot4'), laptopB, 1_000);
    expect(q.match(['limelight.local'], stationScope('slot1'), 1_100)).toEqual([laptopA]);
    expect(q.match(['limelight.local'], stationScope('slot4'), 1_100)).toEqual([laptopB]);
    // An answer on the team's VLAN can't be told apart, so matches neither.
    expect(q.match(['limelight.local'], teamScope(1967), 1_100)).toEqual([]);
  });

  test('prune drops aged entries without touching live ones', () => {
    const q = new PendingQueries(3_000);
    q.add(['radio.local'], teamScope(1234), laptopA, 1_000);
    q.add(['radio.local'], teamScope(1234), laptopB, 3_000);
    q.prune(4_500);
    expect(q.match(['radio.local'], teamScope(1234), 4_500)).toEqual([laptopB]);
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

  test('a unicast answer echoing a query ID reaches each laptop with the ID it expects', () => {
    // A responder answering a legacy-unicast query echoes that query's ID.
    const response = Buffer.alloc(12);
    response.writeUInt16BE(0x1234, 0);
    response.writeUInt16BE(0x8400, 2);
    expect(answerFor(response, { address: '10.55.0.20', port: 5353, id: 0x1234 }).readUInt16BE(0)).toBe(0);
    expect(answerFor(response, { address: '10.55.0.21', port: 50123, id: 0xbeef }).readUInt16BE(0)).toBe(0xbeef);
    const already = Buffer.alloc(12);
    expect(answerFor(already, { address: '10.55.0.20', port: 5353, id: 0 })).toBe(already); // no copy needed
  });
});

describe('per-station mDNS address', () => {
  test('sits just below the gateway octet, one per slot, in the team subnet', () => {
    expect(stationMdnsIp(1967, 'slot1', 254)).toBe('10.19.67.253');
    expect(stationMdnsIp(1967, 'slot6', 254)).toBe('10.19.67.248');
    expect(stationMdnsIp(254, 'slot2', 230)).toBe('10.2.54.228');
  });
});
