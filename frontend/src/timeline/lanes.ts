/**
 * The lanes of the station timeline: what each one shows, in what unit, and
 * how its values read. The renderer knows how to draw a numeric lane and a
 * state lane; this file is where a new measurement gets added.
 */
import type { NumericKey, StationTracks } from './store';
import type { StateSeries } from './series';

/** How a state reads at a glance. `hollow` is "known, and nothing is
 *  happening" (an outline); `off` barely marks the lane (a hairline). */
export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'hollow' | 'off';

export interface StateValueStyle {
  label: string;
  tone: Tone;
}

export interface StateLane {
  kind: 'state';
  id: string;
  title: string;
  series: (tracks: StationTracks) => StateSeries<string>;
  values: Record<string, StateValueStyle>;
}

export interface NumericLaneSeries {
  key: NumericKey;
  /** Names the series in the lane's header. */
  label: string;
  /** Blue for a lane's first measure, orange for its second. */
  color: 'a' | 'b';
  /** Also drawn for the team's other robot. One per lane at most. */
  compare?: boolean;
  /** Shade from the line down to the bottom of the lane (a floor). */
  fillBelow?: boolean;
}

export interface NumericLane {
  kind: 'numeric';
  id: string;
  title: string;
  unit: string;
  decimals: number;
  series: NumericLaneSeries[];
  /** The scale never goes past these. */
  min?: number;
  max?: number;
  /** The scale always reaches at least these, and stretches to fit the data. */
  softMin?: number;
  softMax?: number;
  /** A level worth a line of its own. */
  reference?: { value: number; label: string };
  /** One more figure for the header, worked out from the lane's readings. */
  derived?: { label: string; unit: string; from: (values: Partial<Record<NumericKey, number>>) => number | undefined };
  /** Shade the stretches where this is true (brownout, on the battery lane). */
  shade?: { series: (tracks: StationTracks) => StateSeries<boolean>; label: string };
}

export type Lane = StateLane | NumericLane;

export const LANES: Lane[] = [
  {
    kind: 'state',
    id: 'wifi',
    title: 'Wi-Fi',
    series: t => t.wifi,
    values: {
      none: { label: 'No Wi-Fi', tone: 'off' },
      unlinked: { label: 'Not linked', tone: 'hollow' },
      linked: { label: 'Linked', tone: 'good' },
      excellent: { label: 'Excellent', tone: 'good' },
      good: { label: 'Good', tone: 'good' },
      caution: { label: 'Caution', tone: 'warning' },
      warning: { label: 'Poor', tone: 'serious' },
    },
  },
  {
    kind: 'state',
    id: 'comms',
    title: 'Comms',
    series: t => t.comms,
    values: {
      none: { label: 'No comms', tone: 'hollow' },
      radio: { label: 'Radio only', tone: 'warning' },
      rio: { label: 'No robot code', tone: 'warning' },
      robot: { label: 'Robot', tone: 'good' },
    },
  },
  {
    kind: 'state',
    id: 'robot',
    title: 'Robot',
    series: t => t.robot,
    values: {
      disabled: { label: 'Disabled', tone: 'hollow' },
      auto: { label: 'Auto', tone: 'good' },
      teleop: { label: 'Teleop', tone: 'good' },
      test: { label: 'Test', tone: 'good' },
      util: { label: 'Utility', tone: 'good' },
      estop: { label: 'E-Stop', tone: 'critical' },
      astop: { label: 'A-Stop', tone: 'warning' },
    },
  },
  {
    kind: 'numeric',
    id: 'battery',
    title: 'Battery',
    unit: 'V',
    decimals: 1,
    softMin: 8,
    softMax: 13.5,
    series: [{ key: 'battery', label: '', color: 'a', compare: true }],
    shade: { series: t => t.brownout, label: 'Brownout' },
  },
  {
    kind: 'numeric',
    id: 'signal',
    title: 'Signal',
    unit: 'dBm',
    decimals: 0,
    softMin: -100,
    softMax: -40,
    series: [
      { key: 'signalDbm', label: '', color: 'a', compare: true },
      { key: 'noiseDbm', label: 'Noise', color: 'b', fillBelow: true },
    ],
    derived: {
      label: 'SNR',
      unit: 'dB',
      from: v => (v.signalDbm !== undefined && v.noiseDbm !== undefined ? v.signalDbm - v.noiseDbm : undefined),
    },
  },
  {
    kind: 'numeric',
    id: 'rtt',
    title: 'Round trip',
    unit: 'ms',
    decimals: 0,
    min: 0,
    softMax: 20,
    series: [
      { key: 'linkRttMs', label: 'Field ↔ robot', color: 'a', compare: true },
      { key: 'dsRttMs', label: 'Laptop ↔ robot', color: 'b' },
    ],
  },
  {
    kind: 'numeric',
    id: 'bandwidth',
    title: 'Bandwidth',
    unit: 'Mbps',
    decimals: 1,
    min: 0,
    softMax: 4.5,
    series: [{ key: 'bandwidthMbps', label: '', color: 'a', compare: true }],
    reference: { value: 4, label: '4 Mbps limit' },
  },
  {
    kind: 'numeric',
    id: 'loss',
    title: 'Packet loss',
    unit: '%',
    decimals: 0,
    min: 0,
    softMax: 10,
    series: [{ key: 'linkLossPct', label: '', color: 'a', compare: true }],
  },
  {
    kind: 'numeric',
    id: 'linkRate',
    title: 'Link rate',
    unit: 'Mbps',
    decimals: 0,
    min: 0,
    softMax: 100,
    series: [
      { key: 'rxRateMbps', label: 'From robot', color: 'a', compare: true },
      { key: 'txRateMbps', label: 'To robot', color: 'b' },
    ],
  },
  {
    kind: 'numeric',
    id: 'packets',
    title: 'Packets',
    unit: '/s',
    decimals: 0,
    min: 0,
    softMax: 100,
    series: [
      { key: 'rxPacketsPerSec', label: 'From robot', color: 'a', compare: true },
      { key: 'txPacketsPerSec', label: 'To robot', color: 'b' },
    ],
  },
  {
    kind: 'numeric',
    id: 'dataAge',
    title: 'Data age',
    unit: 'ms',
    decimals: 0,
    min: 0,
    softMax: 100,
    series: [{ key: 'dataAgeMs', label: '', color: 'a', compare: true }],
  },
  {
    kind: 'numeric',
    id: 'dsCpu',
    title: 'Laptop CPU',
    unit: '%',
    decimals: 0,
    min: 0,
    max: 100,
    series: [{ key: 'dsCpuPercent', label: '', color: 'a', compare: true }],
  },
];

/** Shown until the viewer chooses otherwise. */
export const DEFAULT_LANES: readonly string[] = ['wifi', 'comms', 'robot', 'battery', 'signal', 'rtt', 'bandwidth'];
