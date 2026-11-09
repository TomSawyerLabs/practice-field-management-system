# pFMS Documentation

**Standing up a new field? Start with
[getting-started.md](getting-started.md)** — a linear checklist from bare
hardware to your first match.

Otherwise, the [project README](../README.md) has the overview and quick
start. These guides go deeper:

## Guides

| Doc                                      | Covers                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| [getting-started.md](getting-started.md) | **New deployment walkthrough**: hardware, switch/VLAN, firmware, install, first match       |
| [deployment.md](deployment.md)           | Keeping it running: systemd vs Docker, and the trade-offs                                   |
| [setup.md](setup.md)                     | Installation, production deployment, systemd, update script, reverse proxy, external access |
| [configuration.md](configuration.md)     | Environment variable reference, persistence files, trusted proxies                          |
| [match-system.md](match-system.md)       | Match lifecycle, ready check, E-Stop/A-Stop, match window, audio, history                   |
| [games.md](games.md)                     | Game layers: REBUILT, the generic game, choosing one, writing your own (JSON or plugin)     |
| [scoring.md](scoring.md)                 | Scoring HTTP API, elements/sources/dedup, match review API                                  |
| [support.md](support.md)                 | Support widget, issue reports, chat, Slack integration, admin auth                          |
| [network.md](network.md)                 | Network architecture, VLANs, routing, DNAT, device discovery, mDNS                          |
| [robot-tester.md](robot-tester.md)       | The `/test` CSA diagnostic tool, radio programming, firmware updates                        |
| [internals.md](internals.md)             | Startup sequence, configuration flow, graceful reload, telemetry, dry-run mode              |

## Design Documents

| Doc                                                    | Covers                                             |
| ------------------------------------------------------ | -------------------------------------------------- |
| [design/vlan-decoupling.md](design/vlan-decoupling.md) | Station naming and alliance/VLAN decoupling design |

Working notes for in-flight tasks live in [`plans/`](../plans/) (not user
documentation). Known technical debt is tracked in
[`ISSUES.md`](../ISSUES.md).
