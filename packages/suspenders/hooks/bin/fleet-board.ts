// fleet-board.ts — live control-plane dashboard. Read-only over governor.db
// except the decision endpoints (/api/decisions /api/answer /api/ack
// /api/advise) and
// the board-owned decisions table below. Serves a page that polls every
// second (WAL allows concurrent readers).
// Start from anywhere:  bun ~/.claude/bin/fleet-board.ts [--port 7799]
// then open http://127.0.0.1:<port> — dropdown lists every known session;
// focusing a session shows its project's backlog / IN-FLIGHT / DONE board,
// its claims, inbox, lane state, and the event tail.

import type { Database } from "bun:sqlite";
import { BIND, db, PORT } from "../board/context.ts";
import { withBoardErrors } from "../board/helpers.ts";
import { projectList } from "../board/lanes.ts";
import { warmSetupCache } from "../board/setup-cache.ts";
import { readBoardSettings } from "../lib/board-config.ts";
import { openIdentity, tokenUsage } from "../lib/govdb.ts";
import {
	hostGuard,
	isWriteMethod,
	withWriteCookie,
	writeToken,
} from "../lib/host-guard.ts";
import { scrub, servicemon } from "../lib/servicemon.ts";

// W165: the hub-admin plane is an auth_issuance surface — a spoke profile
// never loads it. The specifier rides a variable so the staged bundle check
// passes on spokes, where routes-hub-admin.ts is excluded from the payload.
const HUB_ADMIN_MODULE = "../board/routes-hub-admin.ts";

import { setEnterpriseProvider } from "../board/ent-seam.ts";
import { recoverDecisionEvals } from "../board/decide-eval.ts";
import { enforceIam } from "../board/iam-enforce.ts";
import { getIamGate, setIamGate } from "../board/iam-seam.ts";
import { ensureLaneObservations } from "../board/lane-observations.ts";
import { ensureLaneReadModel } from "../board/lane-read-model.ts";
import { startObservationRelay } from "../board/observation-relay.ts";
import {
	handleActions,
	recoverPendingAdvice,
} from "../board/routes-actions.ts";
import { handleConsultIngress } from "../board/routes-consult.ts";
import { handleConsole } from "../board/routes-console.ts";
import { handleData } from "../board/routes-data.ts";
import { handleDrawer } from "../board/routes-drawer.ts";
import { handleEnterprise } from "../board/routes-enterprise.ts";
import {
	handleFederationUsage,
	handleFederationWork,
} from "../board/routes-federation.ts";
import { handleFleetTree } from "../board/routes-fleet-tree.ts";
import { handleLaneModel } from "../board/routes-lane-model.ts";
import { handleMeta } from "../board/routes-meta.ts";
import { handleObservations } from "../board/routes-observations.ts";
import { handleKnowledgeIngest } from "../board/knowledge-ingest.ts";
import { handleOrch } from "../board/routes-orch.ts";
import { handleFiles } from "../board/routes-files.ts";
import { handleSuggest } from "../board/routes-suggest.ts";
import { handleUsage } from "../board/routes-usage.ts";
import {
	CAP_AUTH_ISSUANCE,
	hasCapability,
	readCapabilities,
} from "../lib/profile.ts";
// W157: seedDemo() self-invokes at demo.ts module load — the monolith
// executed it inline before Bun.serve; the side-effect import keeps that
// timing (nothing else imports the demo module)
import "../board/demo.ts";

const idb = openIdentity(); // W156/W359: /console/hub token plane rides identity.db

ensureLaneObservations(db);
ensureLaneReadModel(db);
recoverDecisionEvals();
recoverPendingAdvice();
const observationRelay = startObservationRelay(db);
process.on("exit", () => observationRelay.stop());

// W775.1: the enterprise overlay injects its provider at boot — the module
// specifier is runtime config (KLH_OVERLAY_MODULE), never code. A module
// that fails to load answers honestly on the console but never fakes the
// entitlements surface.
const entModule = process.env.KLH_OVERLAY_MODULE;
if (entModule)
	await import(entModule)
		.then((m) => {
			if (typeof m.enterpriseProvider !== "function")
				throw new Error("no enterpriseProvider export");
			setEnterpriseProvider(m.enterpriseProvider(db));
			console.log("enterprise overlay provider registered");
			// W844: the browser-SSO gate rides the same overlay module — the
			// optional `iamGate` export. Core-SKU boards (no module export)
			// never register a gate and keep the perimeter untouched.
			if (typeof m.iamGate === "function") {
				setIamGate(m.iamGate(db));
				console.log("enterprise iam gate registered");
			}
		})
		.catch((e) =>
			console.error(`enterprise overlay module failed: ${String(e)}`),
		);

let tokAggAt = 0;
function feedTokens(): void {
	if (tokAggAt && sm.refreshS > 0 && Date.now() - tokAggAt < sm.refreshS * 1000)
		return;
	tokAggAt = Date.now();
	for (const p of projectList()) {
		const agg = { in: 0, out: 0, cacheR: 0, cacheC: 0 };
		for (const t of tokenUsage(db as Database, p, Date.now()).values()) {
			if (!t) continue;
			agg.in += t.in;
			agg.out += t.out;
			agg.cacheR += t.cacheR;
			agg.cacheC += t.cacheC;
		}
		const proj = scrub(p);
		sm.tokensSet("in", agg.in, { project: proj });
		sm.tokensSet("out", agg.out, { project: proj });
		sm.tokensSet("cache_read", agg.cacheR, { project: proj });
		sm.tokensSet("cache_create", agg.cacheC, { project: scrub(p) });
	}
}

const sm = servicemon({
	service: "fleet-board",
	port: PORT,
	onMetrics: feedTokens,
	// W147: suspenders-board.json beats the env at board start (the file IS
	// the config-over-code surface the settings page writes)
	refreshS: readBoardSettings().settings.status_refresh_s,
});

const base = {
	port: PORT,
	hostname: BIND,
	async fetch(req) {
		const url = new URL(req.url);
		// W157: the original 30-route if-chain, order preserved, split into
		// per-area handlers — first match wins exactly as before
		for (const h of [
			handleLaneModel,
			handleObservations,
			handleKnowledgeIngest,
			handleFleetTree,
			handleData,
			handleUsage,
			handleFederationUsage,
			(req2, url2) => handleFederationWork(req2, url2, db),
			handleDrawer,
			handleConsultIngress,
			handleActions,
			handleOrch,
			handleFiles,
			handleSuggest,
			handleConsole,
			(req2, url2) =>
				hasCapability(readCapabilities(), CAP_AUTH_ISSUANCE)
					? import(HUB_ADMIN_MODULE).then((m) =>
							m.handleHubAdmin(req2, url2, db, idb),
						)
					: null,
			handleEnterprise,
			handleMeta,
		]) {
			const r = await h(req, url);
			if (r) return r;
		}
		return new Response("not found", { status: 404 });
	},
};

// W264 perimeter: the host allowlist gates EVERY request (reads included —
// a rebound name must never see sessions/prompts/diffs), every non-GET needs
// the write token, and the board's own HTML pages carry it as a cookie.
// The token file is created at start so `curl` clients can read it at once.
writeToken();
// W852: warm the setup checklist cache at boot — the first page view seeds
// real data (no loading flash) and /api/setup answers instantly.
warmSetupCache();
const served = sm.wrapped(base);
const inner = served.fetch as (req: Request) => Promise<Response>;
Bun.serve({
	...served,
	async fetch(req: Request, server): Promise<Response> {
		const denied = hostGuard(req, {
			bind: BIND,
			write: isWriteMethod(req.method),
		});
		if (denied) return denied;
		const respond = async (r: Request): Promise<Response> =>
			withBoardErrors(r, async () =>
				withWriteCookie(
					await inner(r),
					r,
					server.requestIP(req)?.address ?? null,
				),
			);
		// W844: a registered gate authenticates + authorizes EVERY request
		// server-side before dispatch; gate-less boards keep the perimeter
		// untouched (Core SKU).
		if (getIamGate()) return enforceIam(req, new URL(req.url), respond);
		return respond(req);
	},
});
console.log(
	`fleet board → http://127.0.0.1:${PORT}  (governor.db, 1s poll; writes: /api/answer /api/ack /api/advise /api/comment /api/start /api/ship /api/orchestrate)`,
);

// best-effort Bonjour/mDNS: while the board runs, http://suspenders.local:PORT
// resolves from Bonjour-capable machines on the LAN. The name belongs to the
// dns-sd/avahi child — it vanishes when the board dies (auto-renames to
// suspenders-2.local on conflict). Skip silently when neither tool exists.
// SUSPENDERS_MDNS=0 opts out — on macOS the dns-sd registration claims the
// service host name and poisons .local resolution for the very name it advertises
// demo boards never announce themselves as suspenders.local unless forced —
// a screenshot board must not steal the name the real board owns
const isDemo = process.argv.includes("--demo");
if (
	process.env.SUSPENDERS_MDNS === "1" ||
	(process.env.SUSPENDERS_MDNS !== "0" && !isDemo)
) {
	const mdnsCmd =
		process.platform === "darwin"
			? ["dns-sd", "-R", "suspenders", "_http._tcp", ".", String(PORT)]
			: ["avahi-publish", "-s", "suspenders", "_http._tcp", String(PORT)];
	try {
		const mdns = Bun.spawn(mdnsCmd, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const killMdns = () => {
			try {
				mdns.kill();
			} catch {}
		};
		process.on("exit", killMdns);
		// Bun's exit handlers don't fire on bare SIGTERM/SIGINT — without these,
		// orphaned dns-sd children accumulate and fight over the service name
		process.on("SIGTERM", () => {
			killMdns();
			process.exit(0);
		});
		process.on("SIGINT", () => {
			killMdns();
			process.exit(0);
		});
		console.log(
			`mDNS service "suspenders" registered (Bonjour discovery) — local URL http://127.0.0.1:${PORT}`,
		);
	} catch {
		// no mDNS tooling — loopback URL still works
	}
}
