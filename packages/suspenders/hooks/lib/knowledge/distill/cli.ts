// distill/cli.ts — the operator faces, declared once on the verb-kit:
//   coord knowledge-distill status|run|pause|resume|watch
//   coord knowledge-graph about|neighbours|path|contradictions
// The same specs back the standalone bin (hooks/bin/knowledge-distill.ts).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	defineVerb,
	type Parsed,
	parseVerb,
	renderRegistryHelp,
	renderVerbHelp,
	type VerbSpec,
} from "../../verb-kit.ts";
import {
	aboutTarget,
	contradictions,
	graphPath,
	neighbours,
	nodeById,
	resolveEntry,
} from "./graph.ts";
import { productionHandles } from "./production.ts";
import { runOnce } from "./runner.ts";
import { ensureDistillSchema } from "./schema.ts";
import { distillStatus, renderStatus } from "./status.ts";
import { type Job, JOBS } from "./visits.ts";

const out = (json: boolean, value: unknown, text: string): void => {
	console.log(json ? JSON.stringify(value, null, 2) : text);
};

const jobsFlag = (p: Parsed): Job[] | undefined => {
	const raw = p.flag("--job");
	if (!raw) return undefined;
	const want = raw.split(",").map((s) => s.trim());
	const bad = want.filter((j) => !(JOBS as readonly string[]).includes(j));
	if (bad.length)
		throw new Error(
			`unknown job(s): ${bad.join(",")} — one of ${JOBS.join(",")}`,
		);
	return want as Job[];
};

async function runVerb(p: Parsed): Promise<number> {
	const h = productionHandles();
	try {
		const s = await runOnce(h.deps(), {
			force: p.flag("--force") === "true",
			jobs: jobsFlag(p),
		});
		out(
			p.flag("--json") === "true",
			s,
			`run #${String(s.runId)}: ${s.outcome} · items ${String(s.items)} · tokens ${String(s.tokens)} · ${String(s.ms)}ms${s.preempted ? ` · preempted at ${String(s.stoppedJob)}#${String(s.stoppedEntry)}` : ""}`,
		);
		return 0;
	} finally {
		h.close();
	}
}

async function watchVerb(): Promise<number> {
	for (;;) {
		const h = productionHandles();
		const interval = h.loaded.config.interval_s * 1000;
		try {
			const s = await runOnce(h.deps());
			console.log(
				`[distill] ${new Date().toISOString()} ${s.outcome} items=${String(s.items)} tokens=${String(s.tokens)}`,
			);
		} catch (e) {
			console.error(`[distill] run failed: ${String(e)}`);
		} finally {
			h.close();
		}
		await Bun.sleep(interval);
	}
}

export const DISTILL_VERBS: VerbSpec[] = [
	defineVerb({
		name: "status",
		usage: "usage: knowledge-distill status [--json]",
		switches: ["--json"],
		run: (p) => {
			const h = productionHandles();
			try {
				const st = distillStatus(h.kb, h.loaded.config, {
					issue: h.loaded.issue,
					pausePath: h.pausePath,
					decant: h.decant !== null,
				});
				out(p.flag("--json") === "true", st, renderStatus(st));
				return st.overdue > 0 ? 3 : 0;
			} finally {
				h.close();
			}
		},
	}),
	defineVerb({
		name: "run",
		usage:
			"usage: knowledge-distill run [--once] [--force] [--job extract,decant,staleness,crosslink,dedupe,contradiction,distill] [--json]",
		switches: ["--once", "--force", "--json"],
		flags: ["--job"],
		run: runVerb,
	}),
	defineVerb({
		name: "pause",
		usage: "usage: knowledge-distill pause — writes the kill-switch file",
		run: () => {
			const h = productionHandles();
			try {
				mkdirSync(dirname(h.pausePath), { recursive: true });
				writeFileSync(h.pausePath, `${new Date().toISOString()}\n`);
				console.log(`paused: ${h.pausePath}`);
				return 0;
			} finally {
				h.close();
			}
		},
	}),
	defineVerb({
		name: "resume",
		usage: "usage: knowledge-distill resume — removes the kill-switch file",
		run: () => {
			const h = productionHandles();
			try {
				rmSync(h.pausePath, { force: true });
				console.log(`resumed: ${h.pausePath}`);
				return 0;
			} finally {
				h.close();
			}
		},
	}),
	defineVerb({
		name: "watch",
		usage:
			"usage: knowledge-distill watch — the long-running hub loop (interval_s)",
		run: watchVerb,
	}),
];

const withGraph = <T>(
	fn: (h: ReturnType<typeof productionHandles>) => T,
): T => {
	const h = productionHandles();
	try {
		ensureDistillSchema(h.kb);
		return fn(h);
	} finally {
		h.close();
	}
};

export const GRAPH_VERBS: VerbSpec[] = [
	defineVerb({
		name: "about",
		usage:
			"usage: knowledge-graph about <path|label|W-id|:port|KEY> [--limit n] [--json]",
		minPos: 1,
		flags: ["--limit"],
		switches: ["--json"],
		run: (p) =>
			withGraph((h) => {
				const hits = aboutTarget(
					h.kb,
					p.pos[0] ?? "",
					Number(p.flag("--limit") ?? 20),
				);
				out(
					p.flag("--json") === "true",
					hits,
					hits.length
						? hits
								.map(
									(x) =>
										`${x.knowledgeId === null ? `#${String(x.nodeId)}` : `k${String(x.knowledgeId)}`} [${x.state}${x.stale ? " · stale" : ""} · ${x.edge}] ${x.label}`,
								)
								.join("\n")
						: "no entries touch that target",
				);
				return 0;
			}),
	}),
	defineVerb({
		name: "neighbours",
		usage:
			"usage: knowledge-graph neighbours <knowledge-id|#node|key> [--depth n] [--limit n] [--json]",
		minPos: 1,
		flags: ["--depth", "--limit"],
		switches: ["--json"],
		run: (p) =>
			withGraph((h) => {
				const n = resolveEntry(h.kb, p.pos[0] ?? "");
				if (!n) {
					console.error("knowledge-graph: no such node");
					return 1;
				}
				const rows = neighbours(h.kb, n.id, {
					depth: Number(p.flag("--depth") ?? 2),
					limit: Number(p.flag("--limit") ?? 50),
				});
				out(
					p.flag("--json") === "true",
					rows,
					rows
						.map(
							(r) => `${"  ".repeat(r.depth - 1)}${r.kind}:${r.key} ${r.label}`,
						)
						.join("\n") || "no neighbours",
				);
				return 0;
			}),
	}),
	defineVerb({
		name: "path",
		usage: "usage: knowledge-graph path <a> <b> [--depth n] [--json]",
		minPos: 2,
		flags: ["--depth"],
		switches: ["--json"],
		run: (p) =>
			withGraph((h) => {
				const a = resolveEntry(h.kb, p.pos[0] ?? "");
				const b = resolveEntry(h.kb, p.pos[1] ?? "");
				const ids =
					a && b
						? graphPath(h.kb, a.id, b.id, Number(p.flag("--depth") ?? 4))
						: null;
				const nodes = (ids ?? [])
					.map((id) => nodeById(h.kb, id))
					.filter((x) => x !== null);
				out(
					p.flag("--json") === "true",
					nodes,
					nodes.length
						? nodes.map((x) => `${x.kind}:${x.key}`).join(" → ")
						: "no path",
				);
				return ids ? 0 : 1;
			}),
	}),
	defineVerb({
		name: "contradictions",
		usage: "usage: knowledge-graph contradictions [--json]",
		switches: ["--json"],
		run: (p) =>
			withGraph((h) => {
				const rows = contradictions(h.kb);
				out(
					p.flag("--json") === "true",
					rows,
					rows
						.map(
							(r) =>
								`#${String(r.a)} ${r.aLabel}  ⟂  #${String(r.b)} ${r.bLabel} [${r.state}] ${r.evidence ?? ""}`,
						)
						.join("\n") || "no contradictions flagged",
				);
				return 0;
			}),
	}),
];

/** Nested dispatch for `coord knowledge-distill <sub>` / `knowledge-graph <sub>`. */
export async function dispatchSub(
	prog: string,
	about: string,
	verbs: VerbSpec[],
	rest: string[],
): Promise<number> {
	const [head, ...tail] = rest;
	const spec = verbs.find((v) => v.name === head);
	if (!spec || head === "--help" || head === "-h") {
		console.log(renderRegistryHelp(prog, about, verbs));
		return spec || head === "--help" || head === "-h" ? 0 : 2;
	}
	if (tail.includes("--help") || tail.includes("-h")) {
		console.log(renderVerbHelp(spec));
		return 0;
	}
	const parsed = parseVerb(spec, tail);
	if (!parsed.ok) {
		console.error(`${prog}: ${parsed.message || spec.usage || head}`);
		return 2;
	}
	try {
		const r = await spec.run?.(parsed.parsed);
		return typeof r === "number" ? r : 0;
	} catch (e) {
		console.error(`${prog}: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}
