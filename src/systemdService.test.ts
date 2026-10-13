import { describe, expect, test } from 'bun:test';
import { unitFileFor } from './systemdService.js';

describe('the systemd unit the wizard installs', () => {
  test('runs pFMS as it runs now, from its working directory, restarting and gracefully reloading', () => {
    const unit = unitFileFor({ workingDirectory: '/opt/pfms', execStart: ['/usr/bin/node', '/opt/pfms/dist'] });
    expect(unit).toContain('WorkingDirectory=/opt/pfms\n');
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/pfms/dist\n');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain("ExecReload=/bin/sh -c 'touch /run/pfms-keep-network && kill -HUP $MAINPID'");
    expect(unit).toContain('WantedBy=multi-user.target');
    // No User=: it needs root for VLANs and iptables
    expect(unit).not.toContain('User=');
  });

  test('quotes paths with spaces', () => {
    const unit = unitFileFor({
      workingDirectory: '/srv/field one',
      execStart: ['/usr/bin/node', '/srv/field one/dist'],
    });
    expect(unit).toContain('ExecStart=/usr/bin/node "/srv/field one/dist"\n');
  });
});
