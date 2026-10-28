// hooks/board/routes-console.ts — W147 console: /console /console/buckle /console/local /api/console/me /console/settings(+preview/apply) (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import {
	beltPage,
	type Feature,
	localPage,
	previewPage,
	settingsFormPage,
	settingsIndexPage,
} from "../bin/console-html.ts";
import { recentAdminAudit } from "../lib/govdb/admin-audit.ts";
import type { PolicyGatewayParsed } from "../lib/board/board-config.ts";
import {
	ConfigError,
	parsePolicy,
	policyWritePath,
	readBoardSettings,
	resolvePolicy,
} from "../lib/board/board-config.ts";
import { scrub } from "../lib/servicemon.ts";
import { beltAssetUp, buckleReadProxy } from "./buckle-read-proxy.ts";
import {
	cachedProbes,
	consoleMe,
	gatherBeltView,
	gatherLocalView,
} from "./console-view.ts";
import { BELT_REPO, BUCKLE_REPO, db } from "./context.ts";
import { json, writeGuard } from "./helpers.ts";
import { networkPayload, topologyPayload } from "./network-overview.ts";
// W183.2 — the settings form's preference editor picks from the same
// merged catalog /api/executors serves (one source, both surfaces)
import { executorFeed } from "./routes-data.ts";
import { probeService, withRecovery } from "./service-probe.ts";
import {
	htmlHdr,
	policyPreview,
	settingsApply,
	suspPreview,
} from "./settings.ts";

export async function handleConsole(
	req: Request,
	url: URL,
): Promise<Response | null> {
	const buckleRead = await buckleReadProxy(req, url);
	if (buckleRead) return buckleRead;
	if (url.pathname === "/console")
		return Response.redirect(new URL("/console/buckle", url).toString(), 302);
	if (url.pathname === "/console/belt")
		return Response.redirect(new URL("/console/buckle", url).toString(), 301);
	if (url.pathname === "/console/buckle") {
		const me = consoleMe();
		// W1294.2.1: probe the belt feed's chunk set once per render — the
		// page drops its topology script tags when the runtime home is stale.
		const view = await gatherBeltView();
		view.beltAssetsUp = await beltAssetUp();
		return new Response(await beltPage(view, me), {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	}
	if (url.pathname === "/console/local")
		return new Response(localPage(await gatherLocalView(), consoleMe()), {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	if (url.pathname === "/api/services" && req.method === "GET")
		// W273: every monitored service + its recovery map entry; W361: over
		// the console's shared 15s probe cache (one fan-out with the belt and
		// local pages) — /api/services/probe?id= stays the fresh one-shot
		return json({
			ok: true,
			services: (await cachedProbes()).map(withRecovery),
		});
	if (url.pathname === "/api/console/network" && req.method === "GET")
		// W858.10.3: the Network overview payload — read model + local spoke
		// probe (cached probes; the browser never fetches :4101 itself)
		return json(await networkPayload());
	if (url.pathname === "/api/console/topology" && req.method === "GET")
		return json(topologyPayload());
	if (url.pathname === "/api/services/probe" && req.method === "GET") {
		// W273 re-probe: one service, fresh (the row's self-check affordance)
		const p = await probeService(url.searchParams.get("id") ?? "");
		return p
			? json({ ok: true, service: withRecovery(p) })
			: json({ ok: false, error: "unknown service id" }, 404);
	}
	if (url.pathname === "/api/console/me") {
		// avatar dropdown data: board host's latest actor (unassigned until
		// coord bootstrap --actor bootstrap... see console-view's consoleMe
		const m = consoleMe();
		return json({
			ok: true,
			actor: m.actor,
			tags: m.tags,
			actors: m.actors,
			default_actor: m.defaultActor,
			executor_prefs: readBoardSettings().settings.default_executors ?? [],
		});
	}
	if (url.pathname === "/api/console/audit") {
		// W174: the admin-action trail as JSON — settings/policy applies and
		// key revocations, newest first; ?limit= clamps to 1..200; keyset
		// pagination (W451): ?before=<id> drains older pages
		const limit = Math.min(
			200,
			Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25),
		);
		const before = Number(url.searchParams.get("before")) || undefined;
		const audit = recentAdminAudit(db, limit, before);
		return json({
			ok: true,
			audit,
			nextCursor:
				audit.length === limit ? (audit[audit.length - 1]?.id ?? null) : null,
		});
	}
	if (url.pathname === "/console/settings") {
		const pol = resolvePolicy({ beltRepo: BELT_REPO, buckleRepo: BUCKLE_REPO });
		let gw: PolicyGatewayParsed | null = null;
		let perr: string | null = null;
		if (pol) {
			try {
				gw = parsePolicy(pol.text);
			} catch (e) {
				perr = e instanceof ConfigError ? e.message : String(e);
			}
		}
		return new Response(
			settingsIndexPage({
				pol: pol
					? {
							path: pol.path,
							source: pol.source,
							gateway: gw,
							error: perr,
						}
					: null,
				set: readBoardSettings(),
				executors: await executorFeed(),
				me: consoleMe(),
				audit: recentAdminAudit(db, 25),
			}),
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	}
	if (url.pathname.startsWith("/console/settings/") && req.method === "GET") {
		// settings form pages — one per feature with its REAL config surface
		const f = url.pathname.slice("/console/settings/".length);
		if (f !== "belt" && f !== "buckle" && f !== "suspenders")
			return new Response("not found", { status: 404 });
		const feature: Feature = f;
		// W183.2 — the suspenders form carries the executor-preference editor;
		// its add-picker lists the same catalog the dispatch feed serves
		const executors = f === "suspenders" ? await executorFeed() : [];
		const pol = resolvePolicy({ beltRepo: BELT_REPO, buckleRepo: BUCKLE_REPO });
		let gw: PolicyGatewayParsed | null = null;
		let perr: string | null = null;
		if (pol) {
			try {
				gw = parsePolicy(pol.text);
			} catch (e) {
				perr = e instanceof ConfigError ? e.message : String(e);
			}
		}
		return new Response(
			settingsFormPage(
				feature,
				{
					gateway: gw,
					polError: perr,
					target:
						feature === "suspenders"
							? readBoardSettings().path
							: scrub(policyWritePath()),
					set: readBoardSettings(),
					executors,
				},
				consoleMe(),
			),
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	}
	if (req.method === "POST" && url.pathname === "/console/settings/preview") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const f = new URLSearchParams(await req.text());
		const feat = f.get("feature") ?? "";
		if (feat !== "belt" && feat !== "buckle" && feat !== "suspenders")
			return json({ ok: false, error: "unknown feature" }, 400);
		const me = consoleMe();
		return feat === "suspenders"
			? suspPreview(f, me)
			: policyPreview(feat, f, me);
	}
	if (req.method === "POST" && url.pathname === "/console/settings/apply") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const f = new URLSearchParams(await req.text());
		try {
			return settingsApply(f);
		} catch (e) {
			const a = {
				feature: f.get("feature") ?? "belt",
				diff: [] as string[],
				valuesJson: "",
				mtimeMs: "0",
				target: scrub(policyWritePath()),
				error: e instanceof Error ? e.message : String(e),
			};
			return new Response(previewPage(a, consoleMe()), {
				headers: htmlHdr(),
			});
		}
	}
	return null;
}
