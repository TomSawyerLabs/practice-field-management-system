import { describe, expect, test } from 'bun:test';
import {
  controllerBlockReason,
  evaluateControllerPolicy,
  evaluateQosLimit,
  evaluateSystemCore,
  parseMdnsAnswers,
} from './teamChecker.js';

/**
 * Covers the SystemCore half of the robot tester without a robot on the field:
 *
 *  - the unicast mDNS reply a SystemCore actually sends (captured shape from
 *    5940's SystemCore on 2026-09-13: `_SystemCore._tcp` PTR → SRV
 *    `robot.local:1740` → A), including the name-compression pointers real
 *    responders use — that pointer handling is the risky part of the parser;
 *  - the radio's SystemCore-mode verdict, which must be judged against the
 *    controller that actually answered rather than always demanding "disabled".
 */

const SERVICE = '_SystemCore._tcp.local';
const INSTANCE = `SystemCore-FIRST.${SERVICE}`;
const HOST = 'robot.local';
const PORT = 1740;

function encodeName(name: string): Buffer {
  const labels = name
    .split('.')
    .filter(Boolean)
    .map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  return Buffer.concat([...labels, Buffer.from([0])]);
}

/** A 14-bit compression pointer to an earlier offset (RFC 1035 §4.1.4). */
function pointerTo(offset: number): Buffer {
  return Buffer.from([0xc0 | (offset >> 8), offset & 0xff]);
}

/** Build the PTR + SRV + A response a SystemCore sends, using compression
 *  pointers for the SRV owner name and the A owner name. */
function buildSystemCoreResponse(): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(3, 6); // 3 answers
  const chunks: Buffer[] = [header];
  let offset = header.length;
  const push = (b: Buffer) => {
    chunks.push(b);
    offset += b.length;
  };

  // PTR: _SystemCore._tcp.local -> SystemCore-FIRST._SystemCore._tcp.local
  push(encodeName(SERVICE));
  const instance = encodeName(INSTANCE);
  const ptrHead = Buffer.alloc(10);
  ptrHead.writeUInt16BE(12, 0);
  ptrHead.writeUInt16BE(1, 2);
  ptrHead.writeUInt32BE(120, 4);
  ptrHead.writeUInt16BE(instance.length, 8);
  push(ptrHead);
  const instanceOffset = offset;
  push(instance);

  // SRV: <pointer to instance> -> robot.local:1740
  push(pointerTo(instanceOffset));
  const target = encodeName(HOST);
  const srvHead = Buffer.alloc(10);
  srvHead.writeUInt16BE(33, 0);
  srvHead.writeUInt16BE(1, 2);
  srvHead.writeUInt32BE(120, 4);
  srvHead.writeUInt16BE(6 + target.length, 8);
  push(srvHead);
  const srvData = Buffer.alloc(6);
  srvData.writeUInt16BE(0, 0); // priority
  srvData.writeUInt16BE(0, 2); // weight
  srvData.writeUInt16BE(PORT, 4);
  push(srvData);
  const targetOffset = offset;
  push(target);

  // A: <pointer to robot.local> -> 10.59.40.2
  push(pointerTo(targetOffset));
  const aHead = Buffer.alloc(10);
  aHead.writeUInt16BE(1, 0);
  aHead.writeUInt16BE(1, 2);
  aHead.writeUInt32BE(120, 4);
  aHead.writeUInt16BE(4, 8);
  push(aHead);
  push(Buffer.from([10, 59, 40, 2]));

  return Buffer.concat(chunks);
}

describe('SystemCore discovery reply', () => {
  const answers = parseMdnsAnswers(buildSystemCoreResponse());

  test('reads the service PTR', () => {
    const ptr = answers.find(a => a.type === 'PTR');
    expect(ptr).toBeDefined();
    expect(ptr!.name).toBe(SERVICE);
    expect(ptr!.type === 'PTR' && ptr!.target).toBe(INSTANCE);
  });

  test('reads the SRV host and port through a compression pointer', () => {
    // This is exactly how probeSystemCore picks the record.
    const srv = answers.find(a => a.type === 'SRV' && a.name.toLowerCase().endsWith(SERVICE.toLowerCase()));
    expect(srv).toBeDefined();
    expect(srv!.type === 'SRV' && srv!.target).toBe(HOST);
    expect(srv!.type === 'SRV' && srv!.port).toBe(PORT);
  });

  test('resolves the host to its A record', () => {
    const srv = answers.find(a => a.type === 'SRV');
    const a = answers.find(
      r => r.type === 'A' && r.name.toLowerCase() === (srv as { target: string }).target.toLowerCase(),
    );
    expect(a).toBeDefined();
    expect(a!.type === 'A' && a!.address).toBe('10.59.40.2');
  });

  test('a reply with no SystemCore service yields no SRV for it', () => {
    const empty = Buffer.alloc(12);
    empty.writeUInt16BE(0x8400, 2);
    expect(parseMdnsAnswers(empty)).toHaveLength(0);
  });
});

describe('radio SystemCore mode is judged against the controller that answered', () => {
  test('SystemCore robot + SystemCore mode on = pass', () => {
    const r = evaluateSystemCore({ systemcoreEnabled: true }, 'systemcore');
    expect(r.status).toBe('pass');
    expect(r.expected).toBe('enabled');
  });

  test('SystemCore robot + SystemCore mode off = fail', () => {
    const r = evaluateSystemCore({ systemcoreEnabled: false }, 'systemcore');
    expect(r.status).toBe('fail');
    expect(r.expected).toBe('enabled');
  });

  test('roboRIO + SystemCore mode on = fail', () => {
    const r = evaluateSystemCore({ systemcoreEnabled: true }, 'roboRIO');
    expect(r.status).toBe('fail');
    expect(r.expected).toBe('disabled');
  });

  test('roboRIO + SystemCore mode off = pass', () => {
    expect(evaluateSystemCore({ systemcoreEnabled: false }, 'roboRIO').status).toBe('pass');
  });

  test('no controller found: report the mode, do not judge it', () => {
    const r = evaluateSystemCore({ systemcoreEnabled: true }, null);
    expect(r.status).toBe('pass');
    expect(r.actual).toBe('enabled');
  });

  test('firmware that does not report the mode is not a failure', () => {
    expect(evaluateSystemCore({ version: 'VH-109_1.9.0' }, 'systemcore').status).toBe('pass');
  });
});

describe('field control-system policy', () => {
  test('default says nothing to anyone', () => {
    expect(evaluateControllerPolicy('roboRIO', 'none')).toBeNull();
    expect(evaluateControllerPolicy('systemcore', 'none')).toBeNull();
  });

  test('encourage: roboRIO warns but is allowed, SystemCore passes', () => {
    const rio = evaluateControllerPolicy('roboRIO', 'preferSystemCore');
    expect(rio?.status).toBe('warn');
    expect(rio?.expected).toBe('SystemCore');
    expect(evaluateControllerPolicy('systemcore', 'preferSystemCore')?.status).toBe('pass');
  });

  test('SystemCore only: roboRIO fails', () => {
    expect(evaluateControllerPolicy('roboRIO', 'blockRoboRIO')?.status).toBe('fail');
    expect(evaluateControllerPolicy('systemcore', 'blockRoboRIO')?.status).toBe('pass');
  });

  test('no SystemCore: SystemCore fails', () => {
    expect(evaluateControllerPolicy('systemcore', 'blockSystemCore')?.status).toBe('fail');
    expect(evaluateControllerPolicy('roboRIO', 'blockSystemCore')?.status).toBe('pass');
  });

  test('no controller found: policy stays quiet, whatever it is', () => {
    for (const p of ['preferSystemCore', 'blockRoboRIO', 'blockSystemCore'] as const) {
      expect(evaluateControllerPolicy(null, p)).toBeNull();
    }
  });
});

describe('blocking refuses the enable', () => {
  test('nothing is blocked by default or when only encouraging', () => {
    expect(controllerBlockReason('roboRIO', 'none')).toBeNull();
    expect(controllerBlockReason('systemcore', 'none')).toBeNull();
    expect(controllerBlockReason('roboRIO', 'preferSystemCore')).toBeNull();
  });

  test('SystemCore only blocks a roboRIO, and nothing else', () => {
    expect(controllerBlockReason('roboRIO', 'blockRoboRIO')).toContain('SystemCore only');
    expect(controllerBlockReason('systemcore', 'blockRoboRIO')).toBeNull();
  });

  test('no SystemCore blocks a SystemCore, and nothing else', () => {
    expect(controllerBlockReason('systemcore', 'blockSystemCore')).toContain('not accepting SystemCore');
    expect(controllerBlockReason('roboRIO', 'blockSystemCore')).toBeNull();
  });

  test('an unidentified controller is never blocked', () => {
    for (const p of ['none', 'preferSystemCore', 'blockRoboRIO', 'blockSystemCore'] as const) {
      expect(controllerBlockReason(null, p)).toBeNull();
    }
  });
});

describe('radio bandwidth limit', () => {
  test('the setting alone is reported, not judged', () => {
    expect(evaluateQosLimit({ qosEnabled: true }).status).toBe('pass');
    expect(evaluateQosLimit({ qosEnabled: false }).status).toBe('pass');
    expect(evaluateQosLimit({ qosEnabled: true }).actual).toContain('enabled');
    expect(evaluateQosLimit({ qosEnabled: false }).actual).toContain('disabled');
  });

  test('usage well under the cap passes either way, and is shown', () => {
    const on = evaluateQosLimit({ qosEnabled: true }, 0.2);
    expect(on.status).toBe('pass');
    expect(on.actual).toContain('0.2 Mbps');
    const off = evaluateQosLimit({ qosEnabled: false }, 0.2);
    expect(off.status).toBe('pass');
    expect(off.actual).toContain('0.2 Mbps');
  });

  test('limiter on: warn from 90% of the cap, because the shaping is happening now', () => {
    expect(evaluateQosLimit({ qosEnabled: true }, 3.5).status).toBe('pass');
    expect(evaluateQosLimit({ qosEnabled: true }, 3.6).status).toBe('warn');
    expect(evaluateQosLimit({ qosEnabled: true }, 3.9).message).toContain('throttled right now');
  });

  test('limiter off: silent up to the cap, warn only above it', () => {
    expect(evaluateQosLimit({ qosEnabled: false }, 3.9).status).toBe('pass');
    expect(evaluateQosLimit({ qosEnabled: false }, 4).status).toBe('pass');
    const over = evaluateQosLimit({ qosEnabled: false }, 5.2);
    expect(over.status).toBe('warn');
    expect(over.message).toContain('at an event');
  });

  test('firmware that does not report the setting is not a failure', () => {
    expect(evaluateQosLimit({}, 6).status).toBe('pass');
  });
});
