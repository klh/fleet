// dashboard-routes.ts — W155.3 http-citizenship: methods each known path
// serves. The single source the citizenship gate introspects (HEAD rides
// GET paths; Bun strips its body). Extracted from dashboard.ts at the
// 1200-line stop rule (W1238.6) — W2618 decomposition, content unchanged.
import type { RouteMethods } from "./http-citizenship.ts";

// W155.3 http-citizenship: methods each known path serves — the single
// source the gate introspects (HEAD rides GET paths; Bun strips its body).
export const ROUTES: RouteMethods = {
	"/": ["GET", "HEAD"],
	"/api/status": ["GET", "HEAD"],
	"/api/remotes": ["GET", "HEAD"],
	"/api/network": ["GET", "HEAD"],
	"/api/flow": ["GET", "HEAD"],
	"/api/topology-context": ["GET", "HEAD"],
	"/api/model-access": ["GET", "HEAD"],
	"/api/model-inventory": ["GET", "HEAD"],
	"/api/model-capabilities": ["GET", "HEAD"],
	"/api/catalog": ["GET", "HEAD"],
	"/api/metrics": ["GET", "HEAD"],
	"/api/metrics/history": ["GET", "HEAD"],
	"/api/supervisor": ["GET", "HEAD"],
	"/api/occupancy": ["GET", "HEAD"],
	"/registry.json": ["GET", "HEAD"],
	"/observation.js": ["GET", "HEAD"],
	"/api/route": ["POST"],
	"/llms.txt": ["GET", "HEAD"],
	"/threads-mark.js": ["GET", "HEAD"],
	"/register.js": ["GET", "HEAD"],
	"/dashboard-fleet.js": ["GET", "HEAD"],
	"/dashboard-observability.js": ["GET", "HEAD"],
	"/dashboard-model-access.js": ["GET", "HEAD"],
	"/dashboard-topology.js": ["GET", "HEAD"],
	"/dashboard-topology-model.js": ["GET", "HEAD"],
	"/dashboard-topology-hubs.js": ["GET", "HEAD"],
	"/dashboard-topology-hubs-model.js": ["GET", "HEAD"],
	"/dashboard-occupancy.js": ["GET", "HEAD"],
	"/dashboard-wallclock.js": ["GET", "HEAD"],
	"/dashboard-state.js": ["GET", "HEAD"],
	"/vendor/lit.js": ["GET", "HEAD"],
	"/vendor/uPlot.iife.min.js": ["GET", "HEAD"],
	"/vendor/uPlot.min.css": ["GET", "HEAD"],
};
