// hooks/board/executor-catalog.ts — W224: the executor/model feed's catalog
// layer. Pure functions over belt registry/check rows — deliberately NO db
// or server imports (context.ts would open governor.db at import time, so
// unit tests import THIS module directly instead of the board modules).
import type { BeltEndpoint } from "./belt.ts";

// W183.1 — plane vocabulary (moved verbatim from routes-data.ts): "local"
// (this machine's swarm), "user" (BYO local-models.json), "hub"
// (federation-entitled), "remote" (everything else). locality stays
// "local"|"remote" for back-compat with the UI badge logic.
export interface ExecutorEntry {
	value: string;
	label: string;
	model: string;
	locality: "local" | "remote";
	plane: "local" | "user" | "hub" | "remote";
	reasoningEffort: boolean;
}

// LOCAL = LAN/loopback endpoint (private ip, .local mDNS name); REMOTE =
// everything else — the routing doctrine's default (glm-5.3-flash via z.ai)
// and the stock CLI model endpoints (Anthropic/OpenAI) are cloud-hosted.
// (Moved verbatim from belt.ts, W224: this module must stay db-free.)
export const rowLocality = (r: {
	ip?: string;
	host?: string;
}): "local" | "remote" => {
	const ip = r.ip ?? "";
	const host = (r.host ?? "").toLowerCase();
	return host.endsWith(".local") ||
		ip === "::1" ||
		ip.startsWith("127.") ||
		ip.startsWith("192.168.") ||
		ip.startsWith("10.") ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(ip)
		? "local"
		: "remote";
};

// W224 — the belt rows of the /api/executors feed. The endpoint default
// entry keeps its exact W105 shape (back-compat: executor_prefs values and
// old dispatch picks are value strings); every OTHER live model id in the
// row's /v1/models catalog becomes its own pick — user picks from
// everything. Old belt rows (no models field) degrade to the default entry.
export const buildBeltEntries = (
	rows: BeltEndpoint[],
	hubIds: Set<string>,
): ExecutorEntry[] => {
	const out: ExecutorEntry[] = [];
	for (const r of rows) {
		if (r.protocol !== "openai") continue;
		const tail = r.model ?? String(r.port ?? "");
		if (!r.machine || !tail) continue;
		const loc = rowLocality(r);
		const hub = hubIds.has(tail);
		out.push({
			value: `llm:${r.machine}:${tail}`,
			label: `${hub ? "[HUB] " : ""}${r.machine} · ${tail}${r.ok === false ? " (down)" : ""} (${loc})`,
			model: r.model ?? tail,
			locality: loc,
			plane: hub ? "hub" : "remote",
			reasoningEffort: r.roles?.includes("reasoning") ?? false,
		});
		// W224 — every other live model id in the row's /v1/models catalog
		// becomes its own pick: one entry per (endpoint, model) pair.
		for (const m of r.models ?? []) {
			if (m === r.model) continue; // the default entry covers it
			const hubM = hubIds.has(m);
			out.push({
				value: `llm:${r.machine}:${m}`,
				label: `${hubM ? "[HUB] " : ""}${r.machine} · ${m}${r.ok === false ? " (down)" : ""} (${loc})`,
				model: m,
				locality: loc,
				plane: hubM ? "hub" : "remote",
				reasoningEffort: r.roles?.includes("reasoning") ?? false,
			});
		}
	}
	return out;
};

// W224 — resolve a feed value `llm:<machine>:<model-or-port>` to a belt
// endpoint + optional model override. A port or the configured default
// model matches the row directly (W105 behavior); any catalog id the row's
// models[] lists falls back to machine-level targeting and the override
// rides belt's route-to --model. Garbage tails on a known machine and
// unknown machines return null — /api/start 409s, same as before.
export const resolveLlmTarget = (
	rows: BeltEndpoint[],
	machine: string,
	tail: string,
): { ep: BeltEndpoint; override?: string } | null => {
	const openai = rows.filter(
		(r) => r.machine === machine && r.protocol === "openai",
	);
	const ep =
		openai.find((r) => r.model === tail || String(r.port ?? "") === tail) ??
		openai.find((r) => r.models?.includes(tail));
	if (!ep) return null;
	return {
		ep,
		override: tail === String(ep.port ?? "") ? undefined : tail,
	};
};
