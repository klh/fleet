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
// excluded: launchd-managed separately. Missing/unreadable manifest fails
// safe to the ≤4GB set — under-warming heals in one pass, warming past the
// tier re-loads the 22GB reasoner forever.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIER_PATH =
	process.env.BELT_TIER_MANIFEST ??
	join(homedir(), ".claude", "local-llm", "tier.json");
const PORTS: number[] = (() => {
	try {
		const doc = JSON.parse(readFileSync(TIER_PATH, "utf8")) as {
			warm_ports?: unknown;
		};
		if (
			Array.isArray(doc.warm_ports) &&
			doc.warm_ports.every((p) => typeof p === "number" && p > 0 && p < 65536)
		)
			return doc.warm_ports as number[];
	} catch {
		// fall through to the fail-safe set
	}
	console.error(`keepwarm: no tier manifest at ${TIER_PATH} — minimal set`);
	return [8902, 8913];
})();

async function ping(port: number): Promise<number> {
	const t0 = Date.now();
	try {
		const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: `warm ${Date.now()}` }],
				max_tokens: 1,
				temperature: 0,
			}),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok) throw new Error(String(r.status));
		await r.text(); // consume the body so the connection closes cleanly
		return Date.now() - t0;
	} catch {
		return -1;
	}
}

const results = await Promise.all(PORTS.map(ping));
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
const parts = PORTS.map((p, i) =>
	results[i] < 0
		? red(`✗ :${p} down`)
		: `${green("✓")} ${dim(`:${p}`)} ${dim(fmtMs(results[i]))}`,
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
import { drillFallback } from "./fallback-drill.ts";
const drill = await drillFallback();
{
	const mark = drill.verdict === "pass" ? green("✓") : red("✗");
	const detail =
		drill.verdict === "pass"
			? `${drill.dark ? "z.ai dark, local answered" : "z.ai up"}${drill.model ? ` via ${drill.model}` : ""}`
			: drill.why;
	const ms = drill.verdict === "skipped" ? "" : ` ${fmtMs(drill.ms)}`;
	console.log(
		`  ${dim("fallback")}  ${mark} glm-5.3-flash ${dim(detail + ms)}`,
	);
}
