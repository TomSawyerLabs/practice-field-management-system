/**
 * Build a prefilled "report a bug" link to the pFMS GitHub issues page.
 *
 * This is for the *field operator* reporting a problem with pFMS itself —
 * deliberately not offered in the team-facing support widget, where a team
 * with a robot problem should be talking to the people running the field, not
 * filing an issue upstream.
 *
 * The value is the diagnostics: version, platform, firmware mode and failing
 * checks are exactly what's missing from a "the radio doesn't work" report,
 * and exactly what nobody thinks to include.
 */
import type { SetupProbeState } from '../../../src/types';

/** Upstream project. A fork should point this at its own repo. */
export const PFMS_REPO = 'https://github.com/TomSawyerLabs/practice-field-management-system';

export interface BugReportContext {
  /** Server build (git short SHA). */
  version?: string | null;
  /** Latest setup probe, when reporting from the setup screen. */
  probe?: SetupProbeState | null;
  /** Anything the caller wants to add above the diagnostics. */
  summary?: string;
}

/** GitHub truncates very long URLs, so keep the prefill within reason. */
const MAX_BODY = 6000;

function diagnosticsBlock(ctx: BugReportContext): string {
  const lines: string[] = [];

  lines.push(`- pFMS version: ${ctx.version ?? 'unknown'}`);
  if (typeof navigator !== 'undefined') lines.push(`- Browser: ${navigator.userAgent}`);
  if (typeof window !== 'undefined') {
    lines.push(`- Page: ${window.location.pathname}`);
    lines.push(`- Secure context: ${window.isSecureContext ? 'yes' : 'no'}`);
  }

  const probe = ctx.probe;
  if (probe) {
    lines.push(`- Radio URL: ${probe.radioUrl}`);
    lines.push(`- Trunk interface: ${probe.vlanInterface ?? '(unset)'}`);
    lines.push(`- Field-control interface: ${probe.fieldControlInterface ?? '(the trunk, native VLAN)'}`);
    lines.push(`- Dry run: ${probe.dryRun ? 'yes' : 'no'}`);

    // Only the problems — a wall of passing checks helps nobody.
    const problems = probe.steps.flatMap(step =>
      step.checks
        .filter(check => check.status !== 'pass')
        .map(check => `  - [${step.label}] ${check.label}: ${check.detail}`),
    );
    if (problems.length > 0) {
      lines.push('', 'Failing checks:', ...problems);
    } else {
      lines.push('', 'All setup checks passing.');
    }
  }

  return lines.join('\n');
}

export function buildBugReportUrl(ctx: BugReportContext = {}): string {
  const body = [
    '## What happened',
    '',
    ctx.summary ?? '',
    '',
    '## What you expected',
    '',
    '',
    '## Steps to reproduce',
    '',
    '1. ',
    '',
    '---',
    '',
    '<details><summary>Diagnostics (auto-filled)</summary>',
    '',
    '```',
    diagnosticsBlock(ctx),
    '```',
    '',
    '</details>',
  ]
    .join('\n')
    .slice(0, MAX_BODY);

  const params = new URLSearchParams({ title: '', body });
  return `${PFMS_REPO}/issues/new?${params.toString()}`;
}
