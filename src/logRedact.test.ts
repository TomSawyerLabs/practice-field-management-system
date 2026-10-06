import { describe, expect, test } from 'bun:test';
import { REDACTED, redactForLog } from './logRedact.js';

describe('redactForLog', () => {
  test('an admin login or reconnect never logs its passphrase or token', () => {
    expect(redactForLog({ type: 'adminLogin', passphrase: 'hunter2' })).toEqual({
      type: 'adminLogin',
      passphrase: REDACTED,
    });
    expect(redactForLog({ type: 'adminCheckAuth', token: 'abc123' })).toEqual({
      type: 'adminCheckAuth',
      token: REDACTED,
    });
    expect(redactForLog({ type: 'adminSetPassphrase', passphrase: 'x' })).toEqual({
      type: 'adminSetPassphrase',
      passphrase: REDACTED,
    });
  });

  test('credentials nested in a settings save are redacted, the rest kept', () => {
    const msg = {
      type: 'updateSetupSettings',
      settings: {
        slack: { botToken: 'xoxb-1', appToken: 'xapp-1', channel: '#pfms' },
        timelapse: {
          lights: {
            mode: 'haWebhook',
            startWebhookId: 'abc',
            preActions: [{ url: 'http://x', headers: { Authorization: 'Bearer y', Accept: 'json' } }],
          },
        },
        recordingRetentionDays: 30,
      },
    };
    expect(redactForLog(msg)).toEqual({
      type: 'updateSetupSettings',
      settings: {
        slack: { botToken: REDACTED, appToken: REDACTED, channel: '#pfms' },
        timelapse: {
          lights: {
            mode: 'haWebhook',
            startWebhookId: REDACTED,
            preActions: [{ url: 'http://x', headers: { Authorization: REDACTED, Accept: 'json' } }],
          },
        },
        recordingRetentionDays: 30,
      },
    });
  });

  test('a robot config keeps everything but its Wi-Fi key', () => {
    expect(redactForLog({ type: 'newConfig', ssid: '5940', wpaKey: 'secretkey', teamNumber: 5940 })).toEqual({
      type: 'newConfig',
      ssid: '5940',
      wpaKey: REDACTED,
      teamNumber: 5940,
    });
  });

  test('flags about secrets are not secrets', () => {
    expect(redactForLog({ passphraseConfigured: true, token: null })).toEqual({
      passphraseConfigured: true,
      token: null,
    });
  });

  test('the original message is not modified', () => {
    const msg = { type: 'adminLogin', passphrase: 'hunter2' };
    redactForLog(msg);
    expect(msg.passphrase).toBe('hunter2');
  });
});
