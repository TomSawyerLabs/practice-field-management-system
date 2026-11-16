import type { AdminPushStore } from './adminPushStore.js';
import type { PushOutcome, PushPayload } from './pushService.js';
import type { PushSubscriptionInput } from './types.js';

export interface ForgotPasswordAlertDeps {
  /** Post to the Slack support channel. False when Slack isn't set up. */
  postToSlack: (text: string) => Promise<boolean>;
  pushStore: AdminPushStore;
  sendPush: (subscription: PushSubscriptionInput, payload: PushPayload) => Promise<PushOutcome>;
  /** Where admin resets a password: the field's public address, if it has one. */
  adminUrl: () => string | undefined;
}

/**
 * A team pressed "Forgot password": tell the field's admins everywhere they
 * can be reached, Slack and every admin device with push, and say where it
 * went so the page can tell the team whether anyone heard.
 */
export async function alertForgotPassword(
  deps: ForgotPasswordAlertDeps,
  team: number,
  address: string,
): Promise<{ slack: boolean; push: number }> {
  const where = deps.adminUrl();
  const reset = where ? `<${where}|/admin> → Team logins` : '/admin → Team logins';
  const slack = await deps.postToSlack(
    `:key: Team ${team} forgot its pFMS team password (asked from ${address}). ` +
      `Reset it on ${reset}, then they can set a new one from their team page.`,
  );

  let push = 0;
  const payload: PushPayload = {
    title: `Team ${team} forgot its password`,
    body: `Reset it on /admin → Team logins. Asked from ${address}.`,
    url: where ?? '/admin',
    tag: `team-password-${team}`,
  };
  await Promise.all(
    deps.pushStore.list().map(async device => {
      const outcome = await deps.sendPush(device, payload);
      if (outcome === 'ok') push++;
      else if (outcome === 'gone') deps.pushStore.remove(device.endpoint);
    }),
  );
  return { slack, push };
}
