import { CronJob } from 'cron';
import RadioManager from './radioManager.js';
import type { MatchEngine } from './matchEngine.js';

/**
 * Configuration Scheduler for Radio Management
 *
 * Environment Variables (read in index.ts):
 * - RADIO_CLEAR_SCHEDULE: Cron expression for when to clear configurations (e.g., "0 6 * * *" for daily at 6am)
 * - RADIO_CLEAR_TIMEZONE: Timezone for the cron schedule (optional, defaults to system TZ)
 *
 * `keep` names the robots that stay configured (the host team's), asked
 * afresh each time so a settings change needs no restart.
 */

export function startConfigurationScheduler(
  radioManager: RadioManager,
  schedule: string,
  timezone: string | undefined,
  matchEngine: MatchEngine,
  keep: (ssid: string) => boolean,
): void {
  try {
    const cronJob = new CronJob(
      schedule,
      async () => {
        if (matchEngine.isMatchActive()) {
          console.log('Scheduled configuration clear skipped: match is active');
          return;
        }
        console.log(`Scheduled task triggered: Clearing all radio configurations`);
        try {
          await radioManager.clearAllConfigurations(false, keep);
        } catch (error) {
          console.error(`Error in scheduled configuration clear:`, error);
        }
      },
      null, // onComplete callback
      true, // start immediately
      timezone, // timezone (undefined means use system timezone)
    );

    const timezoneInfo = timezone || 'system default';
    console.log(
      `Scheduled configuration clearing started with cron expression: "${schedule}" (timezone: ${timezoneInfo})`,
    );
    console.log(`Next execution: ${cronJob.nextDate()}`);
  } catch (error) {
    console.error('Failed to start scheduled configuration clearing:', error);
    console.error(`Please check your cron expression format: ${schedule}`);
  }
}
