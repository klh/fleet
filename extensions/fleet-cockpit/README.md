# fleet-cockpit (W2887)

Tracked source of the `/fleetcockpit` pi extension. Install: symlink or copy
this directory into `~/.pi/agent/extensions/fleet-cockpit/`, then `/reload`.

Data sources (all plane-only, honesty law: unknowns render `unreported`):
- `coord fleet --json` — lanes
- `coord governance` — mode
- `work ready` / `work report` — work items
- `coord workers --json` — W2886 worker inventory (rights[] computed by the plane)
- `coord runner list --json` — owner-scoped durable runs (C348)

The live install may lead this copy between flushes; syncs land here per the
W2887 disposition (C342/C347/C350).
