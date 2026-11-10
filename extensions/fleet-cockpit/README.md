# Fleet cockpit

The `/fleetcockpit` command opens the Fleet cockpit in Pi.

For development, register this directory as a native Pi package with
`pi install ./extensions/fleet-cockpit` from the Fleet repository root.
Run `pi list` to verify the registration, then use `/reload` in an open
Pi session. Use a scratch Pi home to test an unpublished checkout.

If a manually installed cockpit exists under
`~/.pi/agent/extensions/fleet-cockpit/`, move it outside Pi's extension
search paths before reloading. Keep the backup until the package loads and
`/fleetcockpit` opens. To reverse the migration, remove the registered
package with `pi remove <source>`, restore the backup, and reload.

Data sources:

- `coord fleet --json` for lanes
- `coord governance` for governance mode
- `work ready` and `work report` for work items
- `coord workers --json` for worker inventory and plane-computed rights
- `coord runner list --json` for owner-scoped durable runs

The cockpit displays unavailable data as `unreported`.
