// advise.ts — LLM advisor for decision forks. Reads a NEED% event from
// governor.db, gathers control-plane context, asks the ONE gated Buckle
// client (inference-buckle.ts) for a recommendation, stores it as fact
// advice.<event-id> (+ ADVICE event back to the asker). The board renders
// the advice inline; a HUMAN always accepts/edits before anything is sent —
// this tool never answers a fork by itself.
// usage: bun hooks/bin/advise.ts <event-id>
// env:   SUSPENDERS_LLM_MODEL (model pin, default "local-reason");
//        endpoint + scoped key ride SUSPENDERS_BUCKLE_URL/TOKEN or the
//        knowledge-buckle credential file — see inference-buckle.ts

import { recommendationOf } from "../lib/advice-quality.ts";
import { readBoardSettings } from "../lib/board-config.ts";
import { isDecisionKind, openStore } from "../lib/govdb.ts";
import { buckleChat, inferenceBuckleRoute } from "../lib/inference-buckle.ts";
import {
	type KevDecision,
	type KevOption,
	kevProbabilityLines,
	kevTypedDecision,
	kevUrl,
	parseOptions,
} from "../lib/kev.ts";
import {
	buildPanelRows,
	cloudLeg,
	consensusOf,
	PANEL_FRAME,
	pinnedLeg,
} from "../lib/oracle-legs.ts";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";

// W656.2: kit-owned parse — the board's routes-actions spawns
// `advise.ts <event-id>`; the surface is one positional, help is new
const USAGE = "usage: bun hooks/bin/advise.ts <event-id>";
const SPEC = defineVerb({
	name: "advise",
	usage: USAGE,
	minPos: 1,
	lax: true,
	switches: ["--panel"],
});
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok || !Number(outcome.parsed.pos[0])) {
	console.error(outcome.message || USAGE);
	process.exit(1);
}
const id = Number(outcome.parsed.pos[0]);
// model preference stays DATA (W1119.1): the board settings pin overrides
// env — no endpoint URL or key is resolved here; the ONE gated Buckle client
// owns endpoint + scoped key + trace (config-over-code)
const SETTINGS = readBoardSettings().settings;
export const ADVISE_HINT = "prefer local reasoning";
export const adviseModel = (
	settings: { recommendation_model?: string },
	env: NodeJS.ProcessEnv = process.env,
): string =>
	settings.recommendation_model?.trim() ||
	env.SUSPENDERS_LLM_MODEL?.trim() ||
	"local-reason";
const now = Date.now();

// W850's 503-busy retry retires with the direct URL leg (W1119.1): the gated
// Buckle client owns the wire, and buckle/belt policy owns retries now.

const db = openStore();
const ev = db
	.query(
		"SELECT id, ts, source, kind, scope, payload, target FROM events WHERE id = ?",
	)
	.get(id) as {
	id: number;
	ts: number;
	source: string;
	kind: string;
	scope: string | null;
	payload: string | null;
	target: string | null;
} | null;
if (!ev || !isDecisionKind(ev.kind)) {
	console.error(
		`event #${id} is ${ev ? ev.kind : "missing"} — advise wants a NEED% fork`,
	);
	process.exit(1);
}

// W217 (owner: ad nauseum): a stale or empty advice fact must never wedge
// the card — every advise run overwrites the single-slot fact with a fresh
// take. The evaluate route keeps the CAPPED HISTORY; this fact stays "latest".
const fk = `advice.${id}`;

let question = "";
// W225: structured options make the fork TYPED — the kev-class pass below
// chooses among them; without them the chat chain advises as before
let options: KevOption[] = [];
try {
	const p = ev.payload ? JSON.parse(ev.payload) : {};
	question = String(p.note ?? p.question ?? ev.payload ?? "");
	options = parseOptions(p.options);
} catch {
	question = String(ev.payload ?? "");
}

// context: who is asking (claims/intent), their recent bus traffic, fleet shape
const claims = db
	.query(
		"SELECT scope, intent FROM claims WHERE sid = ? ORDER BY ts DESC LIMIT 5",
	)
	.all(ev.source) as { scope: string; intent: string | null }[];
const recent = db
	.query(
		"SELECT kind, scope, payload FROM events WHERE source = ? ORDER BY id DESC LIMIT 8",
	)
	.all(ev.source) as {
	kind: string;
	scope: string | null;
	payload: string | null;
}[];
const shape = db
	.query(
		"SELECT state, COUNT(*) AS n FROM work_items WHERE state IN ('READY','CLAIMED','RUNNING','BLOCKED','DONE') GROUP BY state",
	)
	.all() as { state: string; n: number }[];
const zombies = db
	.query("SELECT key, value FROM facts WHERE key LIKE 'zombie.%'")
	.all() as { key: string; value: string }[];

const ctx = [
	`asker: ${ev.source}${claims.length ? ` (claims: ${claims.map((c) => `${c.scope}${c.intent ? ` — ${c.intent}` : ""}`).join("; ")})` : ""}`,
	`event: #${id} ${ev.kind}${ev.scope ? ` scope=${ev.scope}` : ""}, age ${Math.round((now - ev.ts) / 60000)}min`,
	`asker's last bus events: ${recent.map((r) => r.kind + (r.scope ? `(${r.scope})` : "")).join(", ") || "(none)"}`,
	`work graph: ${shape.map((s) => `${s.n} ${s.state}`).join(", ") || "empty"}`,
	zombies.length
		? `zombie flags: ${zombies.map((z) => z.value).join(" | ")}`
		: "",
]
	.filter(Boolean)
	.join("\n");

const sys = `You advise the human operator of a multi-agent coding fleet (governor.db control plane: work graph, event bus, claims, zombies). A lane raised a decision fork. Analyze the context and answer with EXACTLY this shape:
RECOMMENDATION: <the decision, one concrete sentence — pick an option if options are implied>
RATIONALE: <2-4 short bullets, grounded in the context>
RISK: <the main risk of your recommendation, one line>
Be decisive. Never recommend "gather more information" unless the context is truly undecidable. Never invent facts.`;

/** The ONE gated advise leg (W1119.1) — the seam caller-level tests drive:
 *  `deps.env` substitutes the credential pair, `deps.fetcher` the wire.
 *  Throws fail-closed; the caller records the bounded error, never a
 *  placeholder recommendation. */
type GatedAdvise = {
	text: string;
	model: string;
	host: string;
	pt: number;
	ct: number;
	ms: number;
};

async function gatedAdvise(
	user: string,
	deps: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {},
): Promise<GatedAdvise> {
	const env = deps.env ?? process.env;
	const r = await buckleChat(
		{
			model: adviseModel(SETTINGS, env),
			system: sys,
			user,
			maxTokens: 500,
			temperature: 0.2,
			hint: ADVISE_HINT,
			timeoutMs: 120_000,
			...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
		},
		env,
	);
	const text = r.text.trim();
	if (!text) throw new Error("advise gate returned no text");
	const { base } = inferenceBuckleRoute(env);
	return {
		text,
		model: r.model,
		host: `buckle(${base.host})`,
		pt: r.pt,
		ct: r.ct,
		ms: r.ms,
	};
}

// W742.2: --panel fans the SAME fork to BOTH oracle legs (W742.1 panel
// contract); fact carries per-leg verdicts + consensus. A total miss may
// produce explicitly degraded advice through an independent governed route.
if (argv.includes("--panel")) {
	const prompt = [
		PANEL_FRAME,
		`DECISION FORK:\n${question}`,
		`CONTROL-PLANE CONTEXT:\n${ctx}`,
	].join("\n\n");
	const settled = await Promise.allSettled([
		pinnedLeg(prompt, 1500, 120_000),
		cloudLeg(prompt, 1500),
	]);
	const rows = buildPanelRows(settled).map((row) =>
		row.ok && !recommendationOf(row.text)
			? { ...row, ok: false, verdict: null, error: "no usable recommendation" }
			: row,
	);
	for (const r of rows) {
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
		).run(
			Date.now(),
			JSON.stringify({
				for: id,
				model: r.model,
				host: `panel:${r.name}`,
				pt: r.pt,
				ct: r.ct,
				tt: r.pt + r.ct,
				ms: r.ms,
				...(r.error ? { error: r.error.slice(0, 200) } : {}),
			}),
		);
	}
	const ok = rows.find((r) => r.ok && recommendationOf(r.text));
	// A failed panel is still useful evidence. The typed Kev route rides when
	// options are explicit (W1120 owns the Buckle-side Kev migration). Neither
	// fallback is called panel consensus or answers the decision for the owner.
	if (!ok) {
		const msg = rows
			.map((r) => `${r.name}: ${r.error ?? "no text"}`)
			.join(" | ")
			.slice(0, 300);
		const legs = rows.map((r) => ({
			name: r.name,
			ok: r.ok,
			model: r.model,
			verdict: r.verdict,
			ms: r.ms,
			...(r.error ? { error: r.error.slice(0, 200) } : {}),
		}));
		const kev = await kevTypedDecision({ state: ctx, question, options });
		if (kev) {
			db.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
			).run(
				Date.now(),
				JSON.stringify({
					for: id,
					model: kev.model,
					host: `kev(${new URL(kevUrl()).host})`,
					pt: kev.inputTokens,
					ct: kev.outputTokens,
					tt: kev.inputTokens + kev.outputTokens,
					ms: kev.latencyMs,
				}),
			);
			storeKevAdvice(kev, { consensus: "degraded: Kev typed choice", legs });
			process.exit(0);
		}
		// provider rejections are failures (exit 2); gate-unavailable misses
		// degrade — same unavailable split as the single-leg path
		const unavailable = rows.every(
			(r) => !/^buckle inference HTTP/.test(r.error ?? ""),
		);
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)",
		).run(`${fk}.error`, msg, Date.now());
		db.query("DELETE FROM facts WHERE key IN (?, ?)").run(
			fk,
			`${fk}.requested`,
		);
		console.error(`advise #${id} panel failed: ${msg}`);
		process.exit(unavailable ? 0 : 2);
	}
	if (ok) {
		storeAdvice(
			ok.text,
			{ model: ok.model, host: `panel:${ok.name}` },
			{
				consensus: consensusOf(rows),
				legs: rows.map((r) => ({
					name: r.name,
					ok: r.ok,
					model: r.model,
					verdict: r.verdict,
					ms: r.ms,
					...(r.error ? { error: r.error.slice(0, 200) } : {}),
				})),
			},
		);
		console.log(`advised #${id} panel: ${consensusOf(rows)}`);
		process.exit(0);
	}
}

/** W225: the kev typed pass → the advice fact. Same RECOMMENDATION/
 *  RATIONALE/RISK shape as the chat paths so the board card renders it
 *  unchanged; probabilities ride in the rationale. */
function storeKevAdvice(k: KevDecision, panel?: PanelMeta): void {
	const pct = (n: number) => `${Math.round(n * 100)}%`;
	const host = `kev(${new URL(kevUrl()).host})`;
	storeAdvice(
		[
			`RECOMMENDATION: ${k.choice}`,
			`RATIONALE: ${k.model} typed choice pass (one prefill, ${k.inputTokens} in / ${k.outputTokens} out tokens)\n${kevProbabilityLines(
				k,
			)
				.map((l) => `- ${l}`)
				.join("\n")}`,
			`RISK: typed-pass confidence ${pct(k.confidence)}${k.confidence < 0.5 ? " — weak signal, treat as a lead" : ""}`,
		].join("\n"),
		{ model: k.model, host },
		panel,
	);
}

/** W742.2: the panel verdict ride-along — per-leg verdicts + the consensus,
 *  rendered by the board card under the recommendation. */
type PanelMeta = {
	consensus: string;
	legs: {
		name: string;
		ok: boolean;
		model: string;
		verdict: string | null;
		ms: number;
		error?: string;
	}[];
};

function storeAdvice(
	text: string,
	meta: { model: string; host: string },
	panel?: PanelMeta,
) {
	const grab = (m: string) =>
		text
			.split(new RegExp(`^${m}:`, "m"))[1]
			?.split(/^[A-Z]+:/m)[0]
			?.trim() ?? "";
	const rec =
		recommendationOf(text) ??
		options.find((option) => option.label === grab("RECOMMENDATION"))?.label;
	if (!rec) {
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)",
		).run(
			`${fk}.error`,
			"advisor returned no usable RECOMMENDATION line",
			Date.now(),
		);
		db.query("DELETE FROM facts WHERE key IN (?, ?)").run(
			fk,
			`${fk}.requested`,
		);
		console.error(`advise #${id}: advisor returned no usable recommendation`);
		process.exit(2);
	}
	const rationale = grab("RATIONALE");
	const risk = grab("RISK");
	const advice = JSON.stringify({
		rec: rec.slice(0, 500),
		rationale: rationale.slice(0, 900),
		risk: risk.slice(0, 300),
		model: meta.model,
		ts: now,
		...(panel ? { panel } : {}),
	});
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)",
	).run(fk, advice, Date.now());
	// W667: both terminal writes clear the board's in-flight stamp so the
	// next /api/advise can spawn fresh after the dedupe window
	db.query("DELETE FROM facts WHERE key = ?").run(`${fk}.requested`);
	db.query("DELETE FROM facts WHERE key = ?").run(`${fk}.error`);
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'ADVICE', ?, ?, ?)",
	).run(
		Date.now(),
		ev.scope,
		JSON.stringify({
			for: id,
			rec: rec.slice(0, 160),
			...(panel ? { consensus: panel.consensus } : {}),
		}),
		ev.source, // back to the asker: their fork has advice waiting
	);
	console.log(`advised #${id}: ${rec.slice(0, 100)}`);
}

// W225 kev-class typed pass FIRST: a fork with structured options is a
// typed decision — one systemone choice pass on the local 4B answers it
// for ~70 input tokens, where the chat chain burns a full advise prompt.
// Any failure returns null and falls through silently; the gated chain
// below is unchanged.
const kev = await kevTypedDecision({ state: ctx, question, options });
if (kev) {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
	).run(
		Date.now(),
		JSON.stringify({
			for: id,
			model: kev.model,
			host: `kev(${new URL(kevUrl()).host})`,
			pt: kev.inputTokens,
			ct: kev.outputTokens,
			tt: kev.inputTokens + kev.outputTokens,
			ms: kev.latencyMs,
		}),
	);
	storeKevAdvice(kev);
	process.exit(0);
}

// W1119.1: the ONE gated advise leg — the kev typed pass stays ahead of it
// (W1120 owns the Buckle-side Kev migration); the belt/URL/remote legs
// retired with the direct-wire clients.
const t0 = Date.now();
let gated: GatedAdvise;
try {
	// W552.6.1 holds: an empty gate answer is a provider failure — gatedAdvise
	// throws "advise gate returned no text" and the catch exits 2 on it.
	// Fail closed: no belt/URL/remote fallback legs remain (W1119.1).
	gated = await gatedAdvise(
		`DECISION FORK:\n${question}\n\nCONTROL-PLANE CONTEXT:\n${ctx}`,
	);
} catch (e) {
	const msg = e instanceof Error ? e.message : String(e);
	// telemetry even on failure — the routing log shows failed calls too (W28)
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
	).run(
		Date.now(),
		JSON.stringify({
			for: id,
			model: adviseModel(SETTINGS),
			host: "buckle",
			pt: 0,
			ct: 0,
			tt: 0,
			ms: Date.now() - t0,
			error: msg.slice(0, 200),
		}),
	);
	// W1119.1 fail-closed split: the gate ANSWERING (an HTTP status, or the
	// W552.6.1 empty-answer throw) is a provider failure — exit 2. No gate
	// answer at all — unreachable OR unconfigured — degrades: the route wrap
	// guarantees both carry the "buckle inference unavailable" vocabulary.
	// The fork stays open.
	const unavailable = msg.startsWith("buckle inference unavailable");
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)",
	).run(`${fk}.error`, unavailable ? `unavailable: ${msg}` : msg, Date.now());
	db.query("DELETE FROM facts WHERE key = ?").run(`${fk}.requested`);
	console.error(
		unavailable
			? `advise #${id}: gate unavailable (${msg.slice(0, 120)}) — advice unavailable, fork stays open`
			: `advise #${id} failed: ${msg}`,
	);
	process.exit(unavailable ? 0 : 2);
}

// W28 routing telemetry: the gate's real pt/ct ride the llm.call event;
// the fork only closes once a recommendation is stored (storeAdvice).
db.query(
	"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
).run(
	Date.now(),
	JSON.stringify({
		for: id,
		model: gated.model,
		host: gated.host,
		pt: gated.pt,
		ct: gated.ct,
		tt: gated.pt + gated.ct,
		ms: gated.ms,
	}),
);
storeAdvice(gated.text, { model: gated.model, host: gated.host });
