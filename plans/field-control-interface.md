# Field control on any interface

## Goal

Field control (`10.0.100.0/24`, pFMS at `.5`, AP at `.2`) used to have to be
the **native/untagged** VLAN on the host's trunk port. pFMS always put
`10.0.100.5/24` on the bare trunk NIC. Sites whose switch tags field control
on the host port couldn't use pFMS without re-plumbing.

Make the field-control interface a setting: any interface name. Leave it unset
to keep today's behaviour (the bare trunk NIC, i.e. native VLAN).

## Environment / context

- Address assignment: `src/trunkInterface.ts` (`bringUpTrunk` →
  `checkInterfaceIps`, `tearDownTrunk` → `removeAddress`).
- Trunk lifecycle and live rebuild on a settings change: `src/index.ts`
  (`trunkSetting`, `rebuildTrunk`, `applyTrunkSetting`).
- Setup wizard check: `src/setupProbe.ts` `probeFieldControl`. UI:
  `frontend/src/components/SetupPage.tsx`, `interfaces` step.
- Settings: `SetupSettings` + `SETUP_SETTING_VALIDATORS` in `src/types.ts`.
- Station VLAN IDs: `vlanMap` in `src/networkManager.ts`, currently hardcoded
  to 10–60 with a TODO to load them from the radio. The VH radio offers
  alternate VLAN ID sets, so **never hardcode 10–60 as "reserved"**. Compare
  against `vlanMap`.
- Everything else on the trunk (packet capture, mDNS, radio commits, DHCP,
  hairpin rule) is about team VLANs / the uplink, not field control. Sockets
  bind to the address `10.0.100.5`, not an interface, so they don't care where
  it lives.

## Decisions already made (don't re-ask)

- **An interface name, not a VLAN ID.** (User, 2026-10-13.) This covers a
  tagged sub-interface (`eno1.100`), a separate NIC (`eno2`), or a
  netplan-managed VLAN alike.
- **The collision check uses `vlanMap`, not 10–60.** (User: the VH radio has
  alternate VLAN ID selections.)
- **Unset = the trunk NIC itself.** Existing installs are unchanged.
- **Update the docs.** (User.) That includes the stale "no error message"
  claim, since the wizard does flag it.

## Design

- Setting `fieldControlInterface`, env `FIELD_CONTROL_INTERFACE`.
- `bringUpTrunk(trunk, { keepNetwork, fieldControl })`:
  - field-control interface = `fieldControl ?? trunk`.
  - If it exists, use it as-is (set it up, add the address).
  - If it doesn't exist and is named `<parent>.<vid>` with an existing
    parent, pFMS creates the 802.1Q sub-interface. It refuses when the parent
    is the trunk and `vid` is one of the station VLAN IDs (`vlanMap`).
  - Otherwise it refuses with a reason (shown by the wizard, retried every 30 s).
- `tearDownTrunk` removes the address from the field-control interface. It
  **does not delete the interface**: pFMS can't tell whether the operator
  made it (netplan), and a leftover sub-interface with no address is harmless.
- `index.ts`: the rebuild target is the (trunk, field control) pair. Changing
  either one rebuilds.

## Progress log

- [x] Plan
- [x] `trunkInterface.ts` + tests (6 new cases in `trunkInterface.test.ts`)
- [x] settings type/validator, `index.ts` wiring (rebuild on either change)
- [x] setup probe + wizard UI (field next to the trunk picker, Interfaces step)
- [x] docs: getting-started, configuration (env table), internals, network,
      docker-compose comment
- [x] ISSUES.md: `fmsAddress` setting is only read by the probe (side issue)
- [x] typecheck, prettier, full `bun test` (948 pass), commit
- [ ] Not done: the wizard field hasn't been looked at in a browser, and no
      tagged field-control setup has been tried on real hardware

## Findings / gotchas

- `settings.fmsAddress` is only read by the setup probe. Startup always adds
  the hardcoded `10.0.100.5`. Logged in ISSUES.md, not fixed here.

## Things not to do

- Don't test against the real radio. This PC reaches the field. Use a dry
  run or a fake `RADIO_URL`.
- Don't delete the field-control interface on teardown.
