// hooks/lib/repro-gate.ts — W743 repro-first gate. A FAILED work item cannot
// re-mint (`work add "… (re-mint of FAILED <id>")`) or re-dispatch until the
// evidence of record carries either (a) a repro artifact — a failing command
// plus its output — or (b) an explicit no-repro note naming why (environment
// gone, flake proven, carrier death). Quota/carrier deaths auto-exempt: the
// lane_launch_intents death log IS the evidence (state never FAILED yet the
// registered process is proven dead out-of-band).

import {
	inspectLaunchIntent,
	launchIntent,
} from "../../scripts/lib/launch-fencing.ts";

export type FailEvidenceKind = "repro" | "no-repro" | "none";

export type FailEvidence = { kind: FailEvidenceKind; why: string };

const REPRO_MARKER = /\brepro\s*:\s*([\s\S]+)/i;
const NO_REPRO_MARKER = /\bno-repro\s*:\s*([\s\S]+)/i;

// No-repro reason vocabulary — prose a lane writes in `work fail --note`
// without the marker; the note NAMES the reason, the classifier reads it.
// Quota walls and outages belong to the carrier-death family (auto-exempt).
const NO_REPRO_REASONS: readonly (readonly [RegExp, string])[] = [
	[/flakes? proven|proven flak/i, "flake proven"],
	[/environment (?:is )?gone|env gone/i, "environment gone"],
	[
		/carrier (?:death|died)|lane (?:died|death)|session died|host (?:died|down)|machine (?:died|down)|outage/i,
		"carrier death",
	],
	[/quota wall|quota exhaust|\b429\b|rate.?limit/i, "quota wall"],
];

export function classifyFailNote(
	note: string | null | undefined,
): FailEvidence {
	const text = (note ?? "").trim();
	if (!text) return { kind: "none", why: "empty fail note" };
	const noRepro = NO_REPRO_MARKER.exec(text);
	if (noRepro?.[1]?.trim())
		return { kind: "no-repro", why: noRepro[1].trim().slice(0, 200) };
	const repro = REPRO_MARKER.exec(text);
	if (repro?.[1]?.trim())
		return { kind: "repro", why: repro[1].trim().slice(0, 200) };
	for (const [re, name] of NO_REPRO_REASONS)
		if (re.test(text)) return { kind: "no-repro", why: name };
	return { kind: "none", why: "no repro artifact and no named no-repro reason" };
}

// The re-mint convention as it exists in the wild (W719→W722→W723): the new
// item's title carries "(re-mint of FAILED <id>)". A bare "FAILED <id>"
// reference without the re-mint keyword does NOT trip the gate — references
// alone are not re-mints.
export function remintTargets(text: string): string[] {
	return [
		...text.matchAll(/\bre-?mint of (?:an? )?failed\s+([Ww]\d[\w.]*)/gi),
	].map((m) => m[1]);
}

// events has no project column — the item link lives inside the payload JSON.
// Bounded read: a re-mint follows its predecessor closely, so the recent
// window suffices.
export function lastFailNote(
	db: GovernorStoreLike,
	project: string,
	id: string,
): string | null {
	const rows = db
		.query(
			"SELECT payload FROM events WHERE kind='work.failed' ORDER BY ts DESC LIMIT 200",
		)
		.all() as { payload: string }[];
	for (const r of rows) {
		try {
			const p = JSON.parse(r.payload) as {
				work?: string;
				project?: string;
				note?: string;
			};
			if (p.work === id && p.project === project)
				return p.note ? String(p.note) : null;
		} catch {}
	}
	return null;
}

type GovernorStoreLike = {
	query: (sql: string) => {
		get: (...params: never[]) => unknown;
		all: (...params: never[]) => unknown[];
	};
};

// Carrier-death evidence from the launch death log: an intent row whose
// registered process is proven dead while its state never reached FAILED.
// That combination only arises when the carrier (not the work) died.
export function carrierDeathEvidence(
	db: GovernorStoreLike,
	project: string,
	item: string,
): { exempt: true; why: string } | { exempt: false; why: string } {
	const intent = launchIntent(db as never, project, item) as {
		attempt: number;
		sid: string;
		host: string;
		state: string;
	} | null;
	if (
		intent &&
		intent.state !== "FAILED" &&
		inspectLaunchIntent(intent as never) === "dead"
	)
		return {
			exempt: true,
			why: `carrier death in the launch death log: attempt ${intent.attempt} (${intent.sid.slice(0, 8)} @ ${intent.host}) proven dead out-of-band, intent never failed`,
		};
	return { exempt: false, why: "no carrier-death evidence in the launch log" };
}

// Explicit evidence carried on the re-mint's own title/desc: the marker beats
// the predecessor's note and the death log.
export function firstExplicitMarker(text: string): FailEvidence | null {
	const noRepro = NO_REPRO_MARKER.exec(text);
	if (noRepro?.[1]?.trim())
		return { kind: "no-repro", why: noRepro[1].trim().slice(0, 200) };
	const repro = REPRO_MARKER.exec(text);
	if (repro?.[1]?.trim())
		return { kind: "repro", why: repro[1].trim().slice(0, 200) };
	return null;
}

// THE gate. Returns null (pass) or a refusal naming the missing evidence and
// the contract. Inert unless newText references a FAILED item as a re-mint.
export function reproGateRefusal(
	db: GovernorStoreLike,
	project: string,
	newText: string,
): string | null {
	const targets = remintTargets(newText);
	if (targets.length === 0) return null;
	for (const id of targets) {
		const it = db
			.query("SELECT state FROM work_items WHERE project=? AND id=?")
			.get(project, id) as { state: string } | null;
		if (!it) return `re-mint references ${id}: not in this work graph`;
		if (it.state !== "FAILED") continue;
		if (firstExplicitMarker(newText)) return null;
		const ev = classifyFailNote(lastFailNote(db, project, id));
		if (ev.kind !== "none") return null;
		const death = carrierDeathEvidence(db, project, id);
		if (death.exempt) return null;
		return [
			`W743 repro-first gate: ${id} is FAILED with no usable evidence of record.`,
			`The re-mint must carry \`repro: <failing command + output>\` or \`no-repro: <why>\` (environment gone / flake proven / carrier death) in title/desc,`,
			`or the predecessor's fail note or the launch death log must carry it. See work fail --help.`,
		].join(" ");
	}
	return null;
}

// Dispatch-side form: the item exists — read its own text, then gate.
export function reproGateForItem(
	db: GovernorStoreLike,
	project: string,
	item: string,
): string | null {
	const it = db
		.query("SELECT title, description FROM work_items WHERE project=? AND id=?")
		.get(project, item) as { title: string; description: string | null } | null;
	if (!it) return null;
	return reproGateRefusal(db, project, `${it.title} ${it.description ?? ""}`);
}

export type BenchmarkRow = {
	item: string;
	failCount: number;
	reproNotes: number;
	noReproNotes: number;
	unclassifiedNotes: number;
	remintChainDepth: number;
};

// Per-item fail-note classification over a W-lane history snapshot.
export function benchmarkRows(
	items: { id: string; title: string; description: string | null }[],
	failEvents: { payload: string }[],
): Map<string, BenchmarkRow> {
	const rows = new Map<string, BenchmarkRow>();
	for (const it of items)
		rows.set(it.id, {
			item: it.id,
			failCount: 0,
			reproNotes: 0,
			noReproNotes: 0,
			unclassifiedNotes: 0,
			remintChainDepth: 0,
		});
	for (const e of failEvents) {
		try {
			const p = JSON.parse(e.payload) as { work?: string; note?: string };
			const row = p.work ? rows.get(p.work) : undefined;
			if (!row) continue;
			row.failCount++;
			const ev = classifyFailNote(p.note ? String(p.note) : null);
			if (ev.kind === "repro") row.reproNotes++;
			else if (ev.kind === "no-repro") row.noReproNotes++;
			else row.unclassifiedNotes++;
		} catch {}
	}
	return rows;
}

// The W743 benchmark aggregate: repro_success_rate + repeat-FAIL rate.
export function benchmarkRepro(
	items: { id: string; title: string; description: string | null }[],
	failEvents: { payload: string }[],
): {
	items: number;
	failed: number;
	reproSuccessRate: number;
	repeatFailRate: number;
	rows: Map<string, BenchmarkRow>;
} {
	const rows = benchmarkRows(items, failEvents);
	for (const it of items)
		for (const target of remintTargets(`${it.title} ${it.description ?? ""}`))
			if (rows.has(target)) rows.get(target)!.remintChainDepth++;
	const failed = [...rows.values()].filter((r) => r.failCount > 0);
	const totalNotes = failed.reduce((a, r) => a + r.failCount, 0);
	const reproNotes = failed.reduce((a, r) => a + r.reproNotes, 0);
	const repeatFail = failed.filter((r) => r.failCount >= 2).length;
	return {
		items: items.length,
		failed: failed.length,
		reproSuccessRate: totalNotes ? reproNotes / totalNotes : 0,
		repeatFailRate: failed.length ? repeatFail / failed.length : 0,
		rows,
	};
}
