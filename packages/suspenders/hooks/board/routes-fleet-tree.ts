// hooks/board/routes-fleet-tree.ts — W530/W534: the fleet tree, hub-grouped
// like `tree -l`, as a GUI-disconnected surface (owner law): GET /api/fleet-tree
// is the data (any CLI/GUI consumes it), GET /fleet-tree is a demo page built
// with native DOM only (createElement + textContent). Sources: local
// /registry.json + hubs.json
// candidate probes + hubs-demo.json static demo roots (W534). Demo content
// lives in machine config ONLY — this module has zero IKEA knowledge.
// W530.2: single-flight refresh (concurrent misses coalesce into ONE sweep),
// bounded parallel leaf probes (probeLimit, was sequential 700ms each),
// generated_at + last-good snapshot (`stale` on the wire when only demo roots
// answer), manual `?refresh=1` + bounded auto refresh (page, TTL cadence,
// visible tab only). Env knobs (test/CI): SUSPENDERS_LLM_HOME swaps the
// hubs/hubs-demo dir, SUSPENDERS_LOCAL_REGISTRY swaps the local belt URL.
import { readFileSync } from "node:fs";
import { json } from "./helpers.ts";

type Leaf = {
	label: string;
	port?: number;
	tier?: string;
	note?: string;
	up: boolean | null; // null = not probeable (cloud/demo)
};
type Root = {
	label: string;
	demo?: boolean;
	down?: boolean;
	note?: string;
	models: Leaf[];
};

type RegistryDoc = {
	router?: { port: number };
	entries?: {
		alias: string;
		label: string;
		port: number;
		tier?: string;
		engine?: string;
		external?: boolean;
	}[];
};

// W530.2: deps injection (service-probe.ts pattern) — tests drive stub
// registries/leaves without sockets; realDeps reads env knobs per call.
export interface TreeDeps {
	fetchImpl: typeof fetch;
	now: () => number;
	llmHome: () => string;
	localRegistry: () => string;
	probeLimit: number; // max concurrent leaf probes
	probeTimeoutMs: number; // leaf /v1/models probe budget
	registryTimeoutMs: number; // /registry.json fetch budget
}

export const realDeps: TreeDeps = {
	fetchImpl: (url, init) => fetch(url, init),
	now: () => Date.now(),
	llmHome: () =>
		process.env.SUSPENDERS_LLM_HOME ?? `${process.env.HOME}/.claude/local-llm`,
	localRegistry: () =>
		process.env.SUSPENDERS_LOCAL_REGISTRY ?? "http://127.0.0.1:4000",
	probeLimit: 4,
	probeTimeoutMs: 700,
	registryTimeoutMs: 2000,
};

const readJson = (p: string): unknown => {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as unknown;
	} catch {
		return null;
	}
};

const up = async (deps: TreeDeps, url: string): Promise<boolean> => {
	try {
		// any HTTP answer = listening
		await deps.fetchImpl(url, {
			signal: AbortSignal.timeout(deps.probeTimeoutMs),
		});
		return true;
	} catch {
		return false;
	}
};

// W530.2: bounded parallel leaf probes — a worker pool so a registry with
// many entries never serializes 700ms timeouts per leaf.
export const pooled = async <T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> => {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const at = next++;
			out[at] = await fn(items[at]);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	);
	return out;
};

// registry doc → leaves; probeable ports fanned through the bounded pool,
// cloud/demo leaves ride along unprobed (up stays null). `origin` prefixes
// hub leaf URLs ("" for local loopback leaves).
const docLeaves = (
	doc: RegistryDoc,
	origin: string,
): { leaf: Leaf; url: string | null }[] => {
	const out: { leaf: Leaf; url: string | null }[] = [];
	if (doc.router?.port)
		out.push({
			leaf: {
				label: `router :${doc.router.port}`,
				port: doc.router.port,
				tier: "anthropic-shim",
				up: false,
			},
			url: `${origin}:${doc.router.port}/v1/models`,
		});
	for (const e of doc.entries ?? []) {
		if (e.external) {
			out.push({ leaf: { label: `${e.label} (cloud)`, up: null }, url: null });
			continue;
		}
		out.push({
			leaf: {
				label: `${e.label} :${e.port}`,
				port: e.port,
				tier: e.tier,
				up: false,
			},
			url: `${origin}:${e.port}/v1/models`,
		});
	}
	return out;
};

// registry doc → probed leaves; cloud entries stay up:null
const leafModels = async (
	deps: TreeDeps,
	doc: RegistryDoc,
	origin: string,
): Promise<Leaf[]> => {
	const built = docLeaves(doc, origin);
	const ups = await pooled(built, deps.probeLimit, (b) =>
		b.url === null ? Promise.resolve(b.leaf.up) : up(deps, b.url),
	);
	return built.map((b, i) => ({ ...b.leaf, up: ups[i] }));
};

const localRoot = async (deps: TreeDeps): Promise<Root> => {
	const root: Root = { label: "local", models: [] };
	try {
		const r = await deps.fetchImpl(`${deps.localRegistry()}/registry.json`, {
			signal: AbortSignal.timeout(1500),
		});
		if (!r.ok) throw new Error(String(r.status));
		const doc = (await r.json()) as RegistryDoc;
		const o = new URL(deps.localRegistry());
		root.models = await leafModels(deps, doc, `${o.protocol}//${o.hostname}`);
	} catch {
		root.down = true;
	}
	return root;
};

const hubRoot = async (
	deps: TreeDeps,
	label: string,
	cands: string[],
): Promise<Root> => {
	for (const c of cands) {
		try {
			const r = await deps.fetchImpl(`${c.replace(/\/$/, "")}/registry.json`, {
				signal: AbortSignal.timeout(deps.registryTimeoutMs),
			});
			if (!r.ok) continue;
			const doc = (await r.json()) as RegistryDoc;
			// leaf ports ride the candidate HOST, never the candidate's own port
			// (W530.2: origin double-port made every hub leaf probe miss)
			const u = new URL(c);
			return {
				label,
				models: await leafModels(deps, doc, `${u.protocol}//${u.hostname}`),
			};
		} catch {}
	}
	return { label, down: true, models: [] };
};

const demoRoots = (deps: TreeDeps): Root[] => {
	const raw = readJson(`${deps.llmHome()}/hubs-demo.json`);
	if (typeof raw !== "object" || raw === null) return [];
	const out: Root[] = [];
	for (const [label, v] of Object.entries(raw as Record<string, unknown>)) {
		if (label.startsWith("_")) continue;
		const v2 = v as { demo?: boolean; note?: string; models?: unknown };
		const models: Leaf[] = (Array.isArray(v2.models) ? v2.models : []).map(
			(m) => (typeof m === "string" ? { label: m, up: null } : (m as Leaf)),
		);
		out.push({ label, demo: true, note: v2.note, models });
	}
	return out;
};

// W530.2 snapshot wire: what a sweep produces and when. `stale` marks a
// last-good serve: the latest sweep found nothing live, so the last
// fully-good snapshot is shown instead of a bare all-down view.
export interface TreeSnapshot {
	tree: Root[];
	generated_at: string;
	stale?: boolean;
}

// single-flight refresh, last-good fallback, TTL cache — per-instance, so
// tests build isolated sources; the module singleton rides realDeps.
export type TreeSource = {
	tree: (force?: boolean) => Promise<TreeSnapshot>;
};

export const createTreeSource = (deps: TreeDeps): TreeSource => {
	const TTL = 30_000;
	let cache: { at: number; snap: TreeSnapshot } | null = null;
	let lastGood: TreeSnapshot | null = null;
	let inFlight: Promise<TreeSnapshot> | null = null;

	const sweep = async (): Promise<TreeSnapshot> => {
		const hubs = readJson(`${deps.llmHome()}/hubs.json`) as Record<
			string,
			{ candidates?: string[] }
		> | null;
		const jobs: Promise<Root>[] = Object.entries(hubs ?? {})
			.filter(([label]) => label !== "local" && !label.startsWith("_"))
			.map(([label, v]) => hubRoot(deps, label, v?.candidates ?? []));
		const tree = await Promise.all([
			localRoot(deps),
			...jobs,
			...demoRoots(deps),
		]);
		const snap: TreeSnapshot = {
			tree,
			generated_at: new Date(deps.now()).toISOString(),
		};
		if (tree.some((r) => !r.down && !r.demo)) lastGood = snap;
		return snap;
	};

	const refresh = (): Promise<TreeSnapshot> => {
		// single-flight: every caller of an in-flight sweep coalesces onto THAT
		// sweep — manual/force refreshes included (no probe stampede)
		if (inFlight) return inFlight;
		inFlight = (async () => {
			try {
				const snap = await sweep();
				// Cache the served snapshot, including last-good fallback. Keeping
				// the failed sweep here would make the next TTL hit lose stale data.
				const effective =
					!snap.tree.some((r) => !r.down && !r.demo) &&
					lastGood &&
					lastGood !== snap
						? { ...lastGood, stale: true }
						: snap;
				cache = { at: deps.now(), snap: effective };
				return effective;
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};

	return {
		tree: async (force = false) => {
			if (inFlight) return inFlight;
			if (!force && cache && deps.now() - cache.at < TTL) return cache.snap;
			return refresh();
		},
	};
};

const source = createTreeSource(realDeps);

const esc = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const page = (): Response =>
	new Response(
		`<!doctype html>
<html><head><meta charset="utf-8"><title>fleet tree</title>
<style>
:root{color-scheme:dark}
body{margin:24px;background:#0d1117;color:#e6edf3;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font-size:15px;font-weight:600;margin:0 0 12px}
.root{margin:6px 0}
.rootlabel{font-weight:700;color:#79c0ff}
.demo{color:#d29922;font-weight:600}
.down{color:#f85149;font-style:italic}
.leaf{padding-left:2ch;white-space:pre}
.glyph{color:#30363d}
.up{color:#3fb950}
.downleaf{color:#f85149}
.tier{color:#8b949e}
a{color:#58a6ff;text-decoration:none}
button{font:inherit;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:2px 10px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
#stamp{color:#8b949e;margin-left:12px;font-weight:400}
</style></head><body>
<h1>fleet tree — <a href="/">board</a><span id="stamp"></span></h1>
<div style="margin:0 0 12px"><button id="refresh" type="button">refresh</button></div>
<div id="tree">loading…</div>
<script type="module">
const tree = document.getElementById("tree");
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text !== undefined) n.textContent = text;
	return n;
};
const stamp = document.getElementById("stamp");
const btn = document.getElementById("refresh");
const load = async (force) => {
	btn.disabled = true;
	btn.textContent = "refreshing…";
	try {
		const u = force ? "/api/fleet-tree?refresh=1" : "/api/fleet-tree";
		const data = await (await fetch(u)).json();
		tree.replaceChildren();
		stamp.replaceChildren();
		stamp.append(el("span", "tier", new Date(data.generated_at).toLocaleTimeString()));
		if (data.stale) stamp.append(el("span", "down", "  stale — last good"));
		for (const root of data.tree) {
			const row = el("div", "root");
			const head = el("div");
			head.append(el("span", root.demo ? "demo" : "rootlabel", root.label));
			if (root.note) head.append(el("span", "tier", "  — " + root.note));
			if (root.down) head.append(el("span", "down", "  (down)"));
			row.append(head);
			const kids = root.models;
			kids.forEach((m, i) => {
				const line = el("div", "leaf");
				line.append(el("span", "glyph", (i === kids.length - 1 ? "└─ " : "├─ ")));
				line.append(el("span", m.up === false ? "downleaf" : "up", m.label));
				if (m.tier) line.append(el("span", "tier", "  [" + m.tier + "]"));
				if (m.note) line.append(el("span", "tier", "  " + m.note));
				row.append(line);
			});
			tree.append(row);
		}
	} catch {
		stamp.replaceChildren();
		stamp.append(el("span", "downleaf", "fetch failed — retrying on cadence"));
	}
	finally {
		btn.disabled = false;
		btn.textContent = "refresh";
	}
};
btn.addEventListener("click", () => void load(true));
// bounded auto refresh: server TTL cadence, visible tab only
setInterval(() => {
	if (!document.hidden) void load(false);
}, 30000);
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) void load(false);
});
void load(false);
</script></body></html>`,
		{
			headers: { "content-type": "text/html; charset=utf-8" },
		},
	);

export async function handleFleetTree(
	_req: Request,
	url: URL,
	src: TreeSource = source,
): Promise<Response | null> {
	if (url.pathname === "/api/fleet-tree") {
		// ?refresh=1 = manual refresh — bypasses the TTL, coalesces in-flight
		const snap = await src.tree(url.searchParams.get("refresh") === "1");
		return json(snap);
	}
	if (url.pathname === "/fleet-tree") return page();
	return null;
}

// esc() kept for future server-side leaf interpolation — eslint/biome keep
export const _esc = esc;
void esc;
