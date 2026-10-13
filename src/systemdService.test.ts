import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { currentExecStart, unitFileFor } from './systemdService.js';

describe('how the wizard records the way pFMS was started', () => {
  test('from a checkout: bun, ignoring .env, running the source entry point', () => {
    expect(currentExecStart(['/usr/local/bin/bun', '/opt/pfms/src/index.ts'], '/usr/local/bin/bun')).toEqual([
      '/usr/local/bin/bun',
      '--no-env-file',
      resolve('/opt/pfms/src/index.ts'),
    ]);
  });

  test('a packaged binary runs on its own, not with its embedded script path', () => {
    expect(currentExecStart(['bun', '/$bunfs/root/pfms'], '/opt/pfms/pfms')).toEqual(['/opt/pfms/pfms']);
    expect(currentExecStart(['bun', 'B:/~BUN/root/pfms.exe'], 'C:\\pfms\\pfms.exe')).toEqual(['C:\\pfms\\pfms.exe']);
  });
});

describe('the systemd unit the wizard installs', () => {
  test('runs pFMS as it runs now, from its working directory, restarting and gracefully reloading', () => {
    const unit = unitFileFor({
      workingDirectory: '/opt/pfms',
      execStart: ['/usr/local/bin/bun', '--no-env-file', '/opt/pfms/src/index.ts'],
    });
    expect(unit).toContain('WorkingDirectory=/opt/pfms\n');
    expect(unit).toContain('ExecStart=/usr/local/bin/bun --no-env-file /opt/pfms/src/index.ts\n');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=2');
    expect(unit).toContain("ExecReload=/bin/sh -c 'touch /run/pfms-keep-network && kill -HUP $MAINPID'");
    expect(unit).toContain('WantedBy=multi-user.target');
    // No User=: it needs root for VLANs and iptables
    expect(unit).not.toContain('User=');
  });

  test('quotes paths with spaces', () => {
    const unit = unitFileFor({
      workingDirectory: '/srv/field one',
      execStart: ['/usr/local/bin/bun', '/srv/field one/src/index.ts'],
    });
    expect(unit).toContain('ExecStart=/usr/local/bin/bun "/srv/field one/src/index.ts"\n');
  });
});
