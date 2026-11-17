import type { AdminPushStore } from './adminPushStore.js';
import type { PushOutcome, PushPayload } from './pushService.js';
import type { TeamAccessRequest } from './teamAccessRequests.js';
import type { PushSubscriptionInput } from './types.js';

export interface AccessRequestAlertDeps {
  /** Post to the Slack support channel. False when Slack isn't set up. */
  postToSlack: (text: string) => Promise<boolean>;
  pushStore: AdminPushStore;
  sendPush: (subscription: PushSubscriptionInput, payload: PushPayload) => Promise<PushOutcome>;
  /** Where admin answers: the field's public /admin, if it has one. */
  adminUrl: () => string | undefined;
}

/**
 * A team pressed "Forgot password? Ask an admin": tell the field's admins
 * everywhere they can be reached, Slack and every admin device with push, and
 * say where it went so the page can tell the team whether anyone heard.
 */
export async function alertAccessRequest(
  deps: AccessRequestAlertDeps,
  request: TeamAccessRequest,
): Promise<{ slack: boolean; push: number }> {
  const { team, deviceName, address, note } = request;
  const where = deps.adminUrl();
  const admin = where ? `<${where}|/admin> → Team logins` : '/admin → Team logins';
  const who = note ? ` "${note.replace(/[<>&]/g, '')}"` : '';
  const slack = await deps.postToSlack(
    `:key: Team ${team} forgot its pFMS team password and asks to let a device in:${who} ` +
      `(${deviceName} at ${address}). Approve or deny it on ${admin}.`,
  );

  let push = 0;
  const payload: PushPayload = {
    title: `Team ${team} asks to be let in`,
    body: `${note ? `${note}, ` : ''}${deviceName} at ${address}. Approve or deny on /admin.`,
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
