// hooks/board/routes-fleet-tree.ts — W530/W534: the fleet tree, hub-grouped
// like `tree -l`, as a GUI-disconnected surface (owner law): GET /api/fleet-tree
// is the data (any CLI/GUI consumes it), GET /fleet-tree is a demo page built
// with native DOM only (createElement + textContent). Sources: local
// /registry.json + hubs.json
// candidate probes + hubs-demo.json static demo roots (W534). Demo content
// lives in machine config ONLY — this module has zero IKEA knowledge.
import { readFileSync } from "node:fs";
import { json } from "./helpers.ts";

const LLM_HOME = `${process.env.HOME}/.claude/local-llm`;
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

const readJson = (p: string): unknown => {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as unknown;
	} catch {
		return null;
	}
};

const up = async (url: string): Promise<boolean | null> => {
	try {
		await fetch(url, { signal: AbortSignal.timeout(700) });
		return true; // any HTTP answer = listening
	} catch {
		return false;
	}
};

const localRoot = async (): Promise<Root> => {
	const root: Root = { label: "local", models: [] };
	try {
		const r = await fetch("http://127.0.0.1:4000/registry.json", {
			signal: AbortSignal.timeout(1500),
		});
		if (!r.ok) throw new Error(String(r.status));
		const doc = (await r.json()) as RegistryDoc;
		if (doc.router?.port)
			root.models.push({
				label: `router :${doc.router.port}`,
				port: doc.router.port,
				tier: "anthropic-shim",
				up: await up(`http://127.0.0.1:${doc.router.port}/v1/models`),
			});
		for (const e of doc.entries ?? []) {
			if (e.external) {
				root.models.push({ label: `${e.label} (cloud)`, up: null });
				continue;
			}
			root.models.push({
				label: `${e.label} :${e.port}`,
				port: e.port,
				tier: e.tier,
				up: await up(`http://127.0.0.1:${e.port}/v1/models`),
			});
		}
	} catch {
		root.down = true;
	}
	return root;
};

const hubRoot = async (label: string, cands: string[]): Promise<Root> => {
	for (const c of cands) {
		try {
			const r = await fetch(`${c.replace(/\/$/, "")}/registry.json`, {
				signal: AbortSignal.timeout(2000),
			});
			if (!r.ok) continue;
			const doc = (await r.json()) as RegistryDoc;
			const origin = new URL(c).origin;
			const models: Leaf[] = [];
			if (doc.router?.port)
				models.push({
					label: `router :${doc.router.port}`,
					port: doc.router.port,
					tier: "anthropic-shim",
					up: await up(`${origin}:${doc.router.port}/v1/models`),
				});
			for (const e of doc.entries ?? []) {
				if (e.external) {
					models.push({ label: `${e.label} (cloud)`, up: null });
					continue;
				}
				models.push({
					label: `${e.label} :${e.port}`,
					port: e.port,
					tier: e.tier,
					up: await up(`${origin}:${e.port}/v1/models`),
				});
			}
			return { label, models };
		} catch {}
	}
	return { label, down: true, models: [] };
};

const demoRoots = (): Root[] => {
	const raw = readJson(`${LLM_HOME}/hubs-demo.json`);
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

let cache: { at: number; tree: Root[] } | null = null;

const fleetTree = async (): Promise<Root[]> => {
	if (cache && Date.now() - cache.at < 30_000) return cache.tree;
	const hubs = readJson(`${LLM_HOME}/hubs.json`) as Record<
		string,
		{ candidates?: string[] }
	> | null;
	const jobs: Promise<Root>[] = Object.entries(hubs ?? {})
		.filter(([label]) => label !== "local" && !label.startsWith("_"))
		.map(([label, v]) => hubRoot(label, v?.candidates ?? []));
	const tree = await Promise.all([localRoot(), ...jobs, ...demoRoots()]);
	cache = { at: Date.now(), tree };
	return tree;
};

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
</style></head><body>
<h1>fleet tree — <a href="/">board</a></h1>
<div id="tree">loading…</div>
<script type="module">
const tree = document.getElementById("tree");
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text !== undefined) n.textContent = text;
	return n;
};
const data = await (await fetch("/api/fleet-tree")).json();
tree.replaceChildren();
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
</script></body></html>`,
		{
			headers: { "content-type": "text/html; charset=utf-8" },
		},
	);

export async function handleFleetTree(
	_req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/api/fleet-tree")
		return json({ tree: await fleetTree() });
	if (url.pathname === "/fleet-tree") return page();
	return null;
}

// esc() kept for future server-side leaf interpolation — eslint/biome keep
export const _esc = esc;
void esc;
