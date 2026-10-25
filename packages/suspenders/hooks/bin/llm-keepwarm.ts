// llm-keepwarm.ts — ONE keepwarm pass over the resident fleet, then exit.
// launchd (com.klh.llm-keepwarm) re-runs this every 4 min. Purpose: MLX
// weights page out after idle → ~50s first-touch stall; a 1-token generation
// keeps them resident. The prompt carries a nonce so the specialists'
// response-cache doesn't answer from cache (a HIT would skip the forward
// pass and leave the weights paged out).
// W507: the warmed set is the emitted tier manifest (belt bin/registry-emit.ts
// `tier` → ~/.claude/local-llm/tier.json) — ONE emission for the swarm AND
// this script, so the lockstep that was comment-only (the W500 crash root
// cause: this list hardcoding the FULL tier) is structural now. 8912 Kev
// excluded: launchd-managed separately. Missing/unreadable manifest warms
// nothing this pass — under-warming heals in one pass, warming past the
// tier re-loads the 22GB reasoner forever.
// W1119.2 single-buckle-inference: the warm completion rides the buckle gate
// (model-as-data + prefer-local hint) — the direct :890x chat wire is
// retired. Aliases resolve from the emitted direct-tiers catalog (port →
// alias via base URL); tier ports with no chat alias (the rerank rung) drop
// — the gate owns inference, a bare port cannot be warmed through it.
// Default-on: this leg is local liveness (W1124.14 gates CLOUD legs, not
// these).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buckleChat } from "../lib/hub/inference-buckle.ts";

const TIER_PATH =
	process.env.BELT_TIER_MANIFEST ??
	join(homedir(), ".claude", "local-llm", "tier.json");
const TIERS_CATALOG = join(
	homedir(),
	".claude",
	"local-llm",
	"direct-tiers.json",
);
const tierDoc = (() => {
	try {
		return JSON.parse(readFileSync(TIER_PATH, "utf8")) as {
			warm_ports?: unknown;
		};
	} catch {
		console.error(`keepwarm: no tier manifest at ${TIER_PATH} — no warm pass`);
		return {};
	}
})();
const catalogDoc = (() => {
	try {
		return JSON.parse(readFileSync(TIERS_CATALOG, "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return {};
	}
})();
const targets = warmTargets(tierDoc, catalogDoc);

async function warm(alias: string): Promise<number> {
	const t0 = Date.now();
	try {
		await buckleChat(
			{
				model: alias,
				user: `warm ${String(Date.now())}`,
				maxTokens: 1,
				hint: "prefer local",
				timeoutMs: 30_000,
			},
			process.env,
		);
		return Date.now() - t0;
	} catch {
		return -1;
	}
}

const results = await Promise.all(targets.map((t) => warm(t.alias)));
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint =
	(code: string) =>
	(s: string): string =>
		tty ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = paint("2");
const green = paint("32");
const red = paint("31");
const fmtMs = (ms: number) =>
	ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
const parts = targets.map((t, i) =>
	results[i] < 0
		? red(`✗ :${t.port} ${t.alias} down`)
		: `${green("✓")} ${dim(`:${t.port} ${t.alias}`)} ${dim(fmtMs(results[i]))}`,
);
if (targets.length === 0)
	console.log(
		dim(
			"keepwarm: no warmable tier aliases (manifest/catalog absent or disjoint)",
		),
	);
console.log(
	`${dim(`keepwarm ${new Date().toISOString()}`)}  ${parts.join("  ")}`,
);

// W90 remote registry liveness — probe-only, never WoL: waking a hibernating
// NAS every 4 min would defeat hibernation. Endpoints opt in via
// keepwarm_probe in ~/.claude/local-llm/remotes.json.
import { endpointsWithRole, probeEndpoint } from "../lib/remotes.ts";

const probeables = endpointsWithRole("general").filter(
	(e) => e.endpoint.keepwarm_probe,
);
if (probeables.length) {
	const remote = await Promise.all(
		probeables.map(async ({ machine, endpoint }) => {
			const h = await probeEndpoint(machine, endpoint);
			const name = `${machine.name}:${endpoint.port}`;
			return h.alive
				? `${green("✓")} ${dim(name)} ${dim(fmtMs(h.ms))}`
				: `${red(`✗ ${name}`)} ${dim("silent")}`;
		}),
	);
	console.log(`${dim(`  remotes`)}  ${remote.join("  ")}`);
}

// W219.2 gateway fallback drill — /v1/models liveness says nothing about the
// fallback machinery (the 2026-10-06 z.ai TLS outage: gateway "up", lanes
// hard-died on Fallbacks=None). One real glm-5.3-flash request through the
// gateway; when z.ai is dark only a local rung can answer, so a 200 here
// proves the ladder. Skipped (no key) prints, never throws.
import { drillFallback, probeFallbackLiveness } from "./fallback-drill.ts";

// W1124.14: the completion half of the fallback drill is operator opt-in,
// default OFF — a real glm completion through the gateway is idle inference
// when nobody asked. The GET reachability probe + ladder assertion stay on.
const drill = fallbackDrillEnabled()
	? await drillFallback()
	: await probeFallbackLiveness();
{
	const mark =
		drill.verdict === "pass"
			? green("✓")
			: drill.verdict === "fail"
				? red("✗")
				: dim("–");
	const detail =
		drill.verdict === "pass"
			? `${drill.dark ? "z.ai dark, local answered" : "z.ai up"}${drill.model ? ` via ${drill.model}` : ""}`
			: drill.why;
	const ms = drill.verdict === "skipped" ? "" : ` ${fmtMs(drill.ms)}`;
	console.log(
		`  ${dim("fallback")}  ${mark} glm-5.3-flash ${dim(detail + ms)}`,
	);
}

// W623 dispatch prefix-cache keepwarm — replays the captured stable lane
// prefix (tools+system from a real lane request) through the buckle front
// every pass, so idle gaps stop evicting it and dispatch briefs pay
// cache-read rates. Skips (never throws) when the front is down, the admin
// key is absent, or no prefix is captured yet — bin/prefix-keepwarm.ts
// --capture seeds it. cached <n> in the line = residency held.
import {
	ensureKeepwarmAuth,
	loadPrefix,
	prefixCachePath,
	warmOnce,
} from "./prefix-keepwarm.ts";
import {
	cacheDrillEnabled,
	fallbackDrillEnabled,
	prefixWarmEnabled,
	warmTargets,
} from "../lib/gates/keepwarm-gate.ts";

{
	// W1124.14: operator opt-in, default OFF — when unset there is no auth
	// mint, no front contact, no inference (local pings + fallback drill stay).
	const enabled = prefixWarmEnabled();
	const auth = enabled
		? await ensureKeepwarmAuth()
		: {
				mode: "skipped" as const,
				why: "disabled (opt-in BELT_PREFIX_KEEPWARM_ENABLED)",
			};
	const w =
		auth.mode === "enrolled"
			? await warmOnce({
					front: auth.front,
					key: auth.key,
					prefix: loadPrefix(prefixCachePath()),
				})
			: { verdict: "skipped" as const, why: auth.why, ms: 0, usage: null };
	const mark =
		w.verdict === "pass" ? green("✓") : enabled ? red("✗") : dim("–");
	const u = w.usage;
	const tok = u ? ` in ${u.in_tok} cached ${u.cache_r}` : "";
	console.log(`  ${dim("prefix")}  ${mark} ${dim(`${w.why} ${w.ms}ms${tok}`)}`);
}

// W901.1 cache-share drill — audit finding 2 (F2 blindspot): the fallback
// drill proves gateway-up, not cache-warm; a silent cache-share regression
// (affinity off, prefix drift, non-caching rung on top) would surface only
// in the lane-cache jsonl. One attributed same-prefix pair per workhorse
// route (BELT_CACHE_DRILL_ROUTES) through the front /w/cache-drill; the
// warm call must REPORT cache fields and clear the share floor
// (BELT_CACHE_DRILL_FLOOR, default 0.5). The ✗ line is the alert.
import {
	CACHE_SID,
	drillCacheShare,
	drillFloor,
	drillRoutes,
} from "./fallback-drill.ts";

{
	// W1124.14: operator opt-in, default OFF — same shape as the prefix gate.
	const enabled = cacheDrillEnabled();
	const auth = enabled
		? await ensureKeepwarmAuth({ sid: CACHE_SID })
		: {
				mode: "skipped" as const,
				why: "disabled (opt-in BELT_CACHE_DRILL_ENABLED)",
			};
	const c =
		auth.mode === "enrolled"
			? await drillCacheShare({
					front: auth.front,
					key: auth.key,
					routes: drillRoutes(),
					prefix: loadPrefix(prefixCachePath()),
					floor: drillFloor(),
				})
			: {
					verdict: "skipped" as const,
					routes: [],
					floor: drillFloor(),
					why: auth.why,
				};
	const cmark =
		c.verdict === "pass" ? green("✓") : enabled ? red("✗") : dim("–");
	console.log(
		`  ${dim("cache")}  ${cmark} ${dim(`${c.why} floor ${c.floor}`)}`,
	);
}
