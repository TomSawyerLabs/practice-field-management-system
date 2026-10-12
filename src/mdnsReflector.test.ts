import { describe, expect, test } from 'bun:test';
import { PendingQueries, withDnsId } from './mdnsReflector.js';

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
    q.add(['radio.local'], 1234, laptopA, 1_000);
    q.add(['radio.local'], 5940, laptopB, 1_000);
    expect(q.match(['radio.local'], 1234, 1_100)).toEqual([laptopA]);
    expect(q.match(['radio.local'], 5940, 1_100)).toEqual([laptopB]);
  });

  test('an answer nobody asked for goes nowhere', () => {
    const q = new PendingQueries();
    q.add(['roborio-1234-frc.local'], 1234, laptopA, 1_000);
    expect(q.match(['radio.local'], 1234, 1_100)).toEqual([]);
    expect(q.match(['roborio-1234-frc.local'], 5940, 1_100)).toEqual([]);
  });

  test('names match case-insensitively and with or without the trailing dot', () => {
    const q = new PendingQueries();
    q.add(['RoboRIO-1234-FRC.local.'], 1234, laptopA, 1_000);
    expect(q.match(['roborio-1234-frc.local'], 1234, 1_100)).toEqual([laptopA]);
  });

  test('a question ages out after the TTL', () => {
    const q = new PendingQueries(3_000);
    q.add(['radio.local'], 1234, laptopA, 1_000);
    expect(q.match(['radio.local'], 1234, 3_999)).toEqual([laptopA]);
    expect(q.match(['radio.local'], 1234, 4_000)).toEqual([]);
    expect(q.size).toBe(0);
  });

  test('a laptop asking again does not stack, and two laptops both get the answer', () => {
    const q = new PendingQueries();
    q.add(['radio.local'], 1234, laptopA, 1_000);
    q.add(['radio.local'], 1234, laptopA, 1_500);
    q.add(['radio.local'], 1234, laptopB, 1_500);
    expect(q.size).toBe(2);
    expect(q.match(['radio.local'], 1234, 1_600)).toEqual([laptopA, laptopB]);
  });

  test('a multi-name answer reaches each asker once', () => {
    const q = new PendingQueries();
    q.add(['_ni-rt._tcp.local', 'roborio-1234-frc.local'], 1234, laptopA, 1_000);
    expect(q.match(['_ni-rt._tcp.local', 'roborio-1234-frc.local'], 1234, 1_100)).toEqual([laptopA]);
  });

  test('prune drops aged entries without touching live ones', () => {
    const q = new PendingQueries(3_000);
    q.add(['radio.local'], 1234, laptopA, 1_000);
    q.add(['radio.local'], 1234, laptopB, 3_000);
    q.prune(4_500);
    expect(q.match(['radio.local'], 1234, 4_500)).toEqual([laptopB]);
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
