/**
 * fleet-cockpit — W2887 cockpit TUI for pi.
 *
 * /fleetcockpit [overview|work|local|remote|fiddle]
 *   Tab strip at top (1-5), columnar grid (computed per render), fiddle
 *   detail with verbatim rights + honest "unreported".
 *
 * Data (plane only — coord fleet --json, coord governance, work report):
 *   v1 is DEGRADED: workers are inferred from lane name-prefixes and every
 *   such row is stamped reported_by=inferred:name-prefix and dimmed. When
 *   W2886 lands (announced workers on the plane), rows become `hub:announce`
 *   and everything else stays the same.
 *
 * Laws honored: unknowns render `unreported` (never fabricated); rights and
 * refusals show verbatim once the plane computes them; hubs are resources
 * (grouping only), origin is the only containment; no unsolicited model calls.
 *
 * Env: PI_COCKPIT_DOCK=off hides the persistent dock line.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);

const FLEET_CWD = "/Volumes/Sensitive/github/klh/fleet";
const MY_SID = "01a1bb57-31dc-771c-a45d-15e252ef4a79";
const FAST_TIMEOUT = 5_000;
const FLEET_TIMEOUT = 25_000;
const DOCK_OFF = process.env.PI_COCKPIT_DOCK === "off";
const TABS = ["overview", "work", "local", "remote", "fiddle"] as const;
type Tab = (typeof TABS)[number];

// ---------- width helpers (ANSI-aware, ascii-plane assumption) ----------
const SGR = /\x1b\[[0-9;]*m/g;
const vw = (s: string): number => s.replace(SGR, "").length;
function pad(s: string, w: number): string {
	const v = s.replace(SGR, "");
	return v.length >= w ? v : v + " ".repeat(w - v.length);
}
function clip(s: string, w: number): string {
	if (w <= 0) return "";
	const v = s.replace(SGR, "");
	return v.length <= w ? v : v.slice(0, Math.max(0, w - 1)) + "…";
}
/** columnar row: cells truncated+padded to computed widths (plain text in/out) */
function grid(cells: string[], widths: number[]): string {
	return cells.map((c, i) => pad(clip(c, widths[i]), widths[i])).join(" ");
}
function colWidths(rows: string[][]): number[] {
	const n = rows[0]?.length ?? 0;
	const w = Array(n).fill(2);
	for (const r of rows) r.forEach((c, i) => (w[i] = Math.max(w[i], vw(c))));
	if (n > 0) w[n - 1] = Math.min(w[n - 1], 80); // free-text column never owns the whole pane
	return w;
}

// ---------- sparkline ----------
const BARS = " ▁▂▃▄▅▆▇█";
function sparkline(values: number[], width = 24): string {
	const slice = values.slice(-width);
	if (slice.length === 0) return "∅";
	const max = Math.max(1, ...slice);
	return [...slice].map((v) => BARS[Math.min(8, Math.round((v / max) * 8))]).join("");
}

// ---------- data ----------
interface Lane {
	label: string;
	sid: string;
	state: string;
	task: string;
	hub: string;
	live: boolean;
}
interface WorkItem {
	id: string;
	glyph: string;
	state: string;
	age: string;
	title: string;
}
/** W2886 `coord workers --json` row: plane-computed rights + reported_by. */
/** W2886-era shape from `coord runner list --json` (C348): owner-scoped runs. */
interface RunnerRun {
	runId: string;
	state: string;
	model: string;
	provider: string;
	generation: string;
	updatedAt: string;
}
/** W2886 `coord workers --json` row: plane-computed rights + reported_by. */
interface WorkerRow {
	sid: string;
	name: string;
	state: string;
	task: string;
	hubId: string;
	rights: string[];
	reportedBy: string;
	compute: string;
	inference: string;
}
interface Sample {
	t: number;
	live: number;
	working: number;
}
/** selectable entity: lane/worker/hub row carried into the fiddle pane */
type Ent = {
	label: string;
	state: string;
	task: string;
	hub: string;
	rights?: string;
	reportedBy?: string;
	compute?: string;
	inference?: string;
};
const S = {
	fleet: null as null | { mode: string | null; ready: number | null; lanes: Lane[]; total: number },
	fleetAt: 0,
	gov: null as null | string,
	work: null as null | WorkItem[],
	runs: null as null | RunnerRun[],
	runsAt: 0,
	workers: null as null | WorkerRow[],
	samples: [] as Sample[],
	ready: null as null | number,
	busy: new Set<string>(),
};

function hubGuess(label: string): string {
	if (/IKEA/i.test(label)) return "ikea";
	if (/^(autow|glm|W\d)/i.test(label)) return "local-aux";
	return "local";
}

function pushSample(force = false): void {
	const working = S.work?.filter((i) => /working/.test(i.state)).length ?? 0;
	const live = S.fleet?.lanes.filter((l) => l.live).length ?? 0;
	const last = S.samples[S.samples.length - 1];
	if (!force && last && Date.now() - last.t < 15_000) return;
	S.samples.push({ t: Date.now(), live, working });
	if (S.samples.length > 240) S.samples.shift();
}

let dockUi: ExtensionContext["ui"] | null = null;
function renderDock(): void {
	if (!dockUi) return;
	try {
		const sp = sparkline(S.samples.map((s) => s.working));
		dockUi.setWidget?.("fleet-cockpit-dock", [
			`◆ dock · ▶${S.fleet?.lanes.filter((l) => l.live).length ?? "unreported"} · READY ${S.ready ?? "unreported"} · ${sp} · /fleetcockpit`,
		]);
	} catch {
		// widget is best-effort chrome; never take the session down
	}
}

async function refreshFast(): Promise<void> {
	if (S.busy.has("fast")) return;
	S.busy.add("fast");
	try {
		const [gov, ready, work, runs, workers] = await Promise.all([
			exec("coord", ["governance"], { cwd: FLEET_CWD, timeout: FAST_TIMEOUT }).catch(() => null),
			exec("work", ["ready"], { cwd: FLEET_CWD, timeout: FAST_TIMEOUT }).catch(() => null),
			exec("work", ["report"], { cwd: FLEET_CWD, timeout: FAST_TIMEOUT }).catch(() => null),
			exec("coord", ["runner", "list", "--json"], { cwd: FLEET_CWD, timeout: FAST_TIMEOUT }).catch(() => null),
			exec("coord", ["workers", "--json"], { cwd: FLEET_CWD, timeout: FAST_TIMEOUT }).catch(() => null),
		]);
		if (gov) S.gov = gov.stdout.trim().split(/\s+/)[0] ?? null;
		if (ready) {
			const lines = ready.stdout.trim().split("\n").filter((l) => l && l.trim() !== "(none)");
			S.ready = lines.length;
		}
		if (work) S.work = parseWorkReport(work.stdout);
		if (runs) {
			try {
				const j = JSON.parse(runs.stdout) as Record<string, unknown>;
				const raw = Array.isArray(j) ? j : Array.isArray(j.runs) ? (j.runs as Array<Record<string, unknown>>) : [];
				S.runs = raw.map((r) => ({
					runId: String(r.runId ?? r.id ?? "unreported"),
					state: String(r.state ?? "unreported"),
					model: String(r.model ?? "unreported"),
					provider: String(r.provider ?? "unreported"),
					generation: String(r.generation ?? "unreported"),
					updatedAt: String(r.updatedAt ?? ""),
				}));
				S.runsAt = Date.now();
			} catch {
				S.runs = null; // parse failure renders as an honest gap, never stale fiction
			}
		} else {
			S.runs = null;
		}
		if (workers) {
			try {
				const j = JSON.parse(workers.stdout) as Record<string, unknown>;
				const raw = Array.isArray(j.workers) ? (j.workers as Array<Record<string, unknown>>) : [];
				S.workers = raw.map((w) => {
					const comp = (w.compute ?? {}) as Record<string, unknown>;
					const inf = Array.isArray(w.inference) ? (w.inference as Array<Record<string, unknown>>) : [];
					return {
						sid: String(w.sid ?? "unreported"),
						name: String(w.name ?? w.sid ?? "unreported"),
						state: String(w.state ?? "unreported"),
						task: String(w.task ?? "unreported"),
						hubId: String(comp.hub_id ?? "unreported"),
						rights: Array.isArray(w.rights) ? (w.rights as string[]).map(String) : [],
						reportedBy: String(w.reported_by ?? "unreported"),
						compute: `kind:${String(comp.kind ?? "unreported")} · host:${String(comp.host ?? "unreported")}`,
						inference: inf.length ? inf.map((i) => String((i as Record<string, unknown>).model ?? "?")).join(",") : "unreported",
					};
				});
			} catch {
				S.workers = null;
			}
		} else {
			S.workers = null;
		}
		renderDock();
	} finally {
		S.busy.delete("fast");
	}
	pushSample();
}

function parseWorkReport(text: string): WorkItem[] {
	const items: WorkItem[] = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^- \[([W][\d.]+)\]\(\S*\) · (\S+) (\S+)(?: · age (\S+))? — (.+)$/);
		if (m) items.push({ id: m[1], glyph: m[2], state: m[3], age: m[4] ?? "—", title: m[5].trim() });
	}
	return items;
}

async function refreshFleet(): Promise<void> {
	if (S.busy.has("fleet")) return;
	S.busy.add("fleet");
	try {
		const r = await exec("coord", ["fleet", "--json"], { cwd: FLEET_CWD, timeout: FLEET_TIMEOUT }).catch(() => null);
		if (!r) return;
		const j = JSON.parse(r.stdout) as Record<string, unknown>;
		const raw = (Array.isArray(j.lanes) ? j.lanes : []) as Array<Record<string, unknown>>;
		const lanes: Lane[] = raw.map((l) => {
			const sid = String(l.sid ?? "");
			const label = String(l.label ?? l.name ?? (sid ? sid.slice(0, 12) + "…" : "?"));
			const state = String(l.state ?? "unreported");
			return {
				label,
				sid: sid || "unreported",
				state,
				task: String(l.task ?? l.intent ?? "unreported"),
				hub: hubGuess(label),
				live: l.live === true || /RUNNING/i.test(state),
			};
		});
		S.fleet = {
			mode: S.gov,
			ready: S.ready,
			lanes,
			total: typeof j.total === "number" ? j.total : lanes.length,
		};
		S.fleetAt = Date.now();
		pushSample(true);
		renderDock();
	} catch {
		// keep last good snapshot; staleness line stays honest
	} finally {
		S.busy.delete("fleet");
	}
	pushSample();
}

function age(at: number): string {
	const s = Math.round((Date.now() - at) / 1000);
	return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

// ---------- tab renderers (plain rows; styled + gridded by panel) ----------
function overviewRows(): string[][] {
	const lanes = S.fleet?.lanes ?? [];
	return lanes
		.map((l) => [l.label, l.live ? "▶" : l.state, l.hub, l.task])
		.sort((a, b) => Number(b[1] === "▶") - Number(a[1] === "▶"));
}
function workRows(): string[][] {
	return (S.work ?? [])
		.map((i) => [i.id, i.glyph, i.state, i.age, i.title])
		.sort((a, b) => Number(b[1] === "◐") - Number(a[1] === "◐"));
}
function localRows(): string[][] {
	const rows: string[][] = [["pi@muramasa (me)", "▶", "session", MY_SID.slice(0, 8) + "…"]];
	const claims = (S.work ?? []).filter((i) => /W2887|W2888|W2889/.test(i.id));
	for (const c of claims) rows.push(["├─ " + c.id, c.glyph, c.state, c.title]);
	const runs = S.runs ?? [];
	for (const r of runs) {
		const at = r.updatedAt ? (Number.isFinite(+r.updatedAt) ? +r.updatedAt : Date.parse(r.updatedAt)) : NaN;
		rows.push([
			"├─ run " + r.runId.slice(0, 8),
			/RUN|ACTIVE|CLAIM/i.test(r.state) ? "▶" : r.state,
			`${r.provider}/${r.model}`,
			`gen:${r.generation}${Number.isFinite(at) ? ` · ${age(at)} old` : ""}`,
		]);
	}
	if (S.runs !== null && S.runs.length === 0) rows.push(["├─ runs", "·", "ok", "0 owner-scoped runs"]);
	if (S.runs === null) rows.push(["├─ runs", "·", "unreported", "coord runner list unavailable"]);
	const mine = (S.fleet?.lanes ?? []).filter((l) => l.sid.includes(MY_SID));
	for (const l of mine) rows.push(["└─ lane", l.live ? "▶" : l.state, "lane", l.task]);
	if (rows.length === 1) rows.push(["└─ unreported", "·", "unreported", "unreported"]);
	return rows;
}
function remoteRows(): { rows: string[][]; entityOf: Array<{ label: string; state: string; task: string; hub: string } | null> } {
	const others = (S.fleet?.lanes ?? []).filter((l) => !l.sid.includes(MY_SID));
	const hubs = new Map<string, Lane[]>();
	for (const l of others) {
		const a = hubs.get(l.hub) ?? [];
		a.push(l);
		hubs.set(l.hub, a);
	}
	const rows: string[][] = [];
	const entityOf: Array<Ent | null> = [];
	for (const [hub, ls] of [...hubs.entries()].sort()) {
		rows.push([`▣ ${hub}`, "", `resource:${hub}`, `${ls.length} lane(s) · grouping only, no containment`]);
		entityOf.push({ label: hub, state: "resource", task: `${ls.length} lane(s)`, hub });
		for (const l of ls) {
			rows.push([`   ├─ ${l.label}`, l.live ? "▶" : l.state, "unreported", l.task]);
			entityOf.push({ label: l.label, state: l.state, task: l.task, hub });
		}
	}
	const workers = S.workers ?? [];
	if (workers.length > 0) {
		rows.push([`▣ plane workers (${workers.length})`, "", "resource:plane", "rights[] computed by the plane · grouping only, no containment"]);
		entityOf.push({ label: "plane workers", state: "resource", task: `${workers.length} worker(s)`, hub: "local" });
		for (const w of workers) {
			rows.push([`   ├─ ${w.name}`, /RUN/i.test(w.state) ? "▶" : w.state, w.rights.join("+") || "no-rights", `${w.task} · ${w.compute} · by ${w.reportedBy}`]);
			entityOf.push({ label: w.name, state: w.state, task: w.task, hub: w.hubId, rights: w.rights.join("+") || "no-rights", reportedBy: w.reportedBy, compute: w.compute, inference: w.inference });
		}
	} else if (S.workers === null) {
		rows.push(["├─ workers", "·", "unreported", "coord workers --json unavailable"]);
		entityOf.push(null);
	}
	if (rows.length === 0) {
		rows.push(["unreported", "·", "unreported", "no remote lanes reported by the plane"]);
		entityOf.push(null);
	}
	return { rows, entityOf };
}
function fiddleRows(sel: Ent | null): string[][] {
	if (!sel) return [["(no selection)", "", "", "navigate a tab, press Enter to fiddle an entity"]];
	const sp = sparkline(S.samples.map((s) => s.working));
	return [
		["entity", "", "", sel.label],
		["state", "", "", sel.state],
		["origin", "", "", "unreported"],
		["compute", "", "", sel.compute ?? `kind:${sel.hub} · host:unreported · region:unreported`],
		["inference", "", "", sel.inference ?? "unreported"],
		["rights", "", "", sel.rights ?? "unreported"], // plane emits these post-W2886
		["task", "", "", sel.task],
		["reported_by", "", "", sel.reportedBy ?? "inferred:name-prefix"],
		["activity", "", "", `${sp}  (working over ${S.samples.length} samples)`],
	];
}

// ---------- extension ----------
export default function fleetCockpit(pi: ExtensionAPI) {
	let sel: Ent | null = null;

	async function panel(startTab: Tab, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("fleetcockpit needs a TUI session", "error");
			return;
		}
		let tab: Tab = TABS.includes(startTab) ? startTab : "overview";
		let scroll = 0;
		let tuiRef: { requestRender: () => void } | null = null;

		void refreshFast();
		void refreshFleet().then(() => tuiRef?.requestRender());

		const kicker = setInterval(() => {
			void refreshFast().then(() => tuiRef?.requestRender());
		}, 20_000);

		try {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				tuiRef = tui;
				const fg = theme.fg.bind(theme);

				const header = (w: number): string[] => {
					const sp = sparkline(S.samples.map((s) => s.working));
					const tabs = TABS.map((t) => (t === tab ? fg("accent", `[${t}]`) : fg("dim", t))).join(fg("dim", " · "));
					const meta = fg(
						"dim",
						clip(
							`mode:${S.gov ?? "unreported"} · READY ${S.ready ?? "unreported"} · ▶${S.samples.at(-1)?.live ?? 0} · ▁${sp} · data ${S.fleetAt ? age(S.fleetAt) : "sampling…"}`,
							w,
						),
					);
					const tabLine = vw(tabs) <= w ? tabs : fg("accent", clip(`[${tab}]`, w));
					return [fg("accent", clip("◆ FLEET COCKPIT", w)), tabLine, meta];
				};

				const render = (w: number): string[] => {
					const lines = header(w);
					let rows: string[][] = [];
					if (tab === "overview") rows = overviewRows();
					else if (tab === "work") rows = workRows();
					else if (tab === "local") rows = localRows();
					else if (tab === "remote") rows = remoteRows().rows;
					else rows = fiddleRows(sel);

					const widths = colWidths(rows);
					const bodyH = Math.max(6, (process.stdout.rows ?? 24) - 10);
					scroll = Math.min(scroll, Math.max(0, rows.length - bodyH));
					const view = rows.slice(scroll, scroll + bodyH);
					for (const r of view) {
						const plain = grid(r, widths);
						const degraded = plain.includes("unreported") || plain.includes("inferred");
						const live = r[1] === "▶" || r[1] === "◐";
						lines.push(clip(degraded ? fg("dim", plain) : fg(live ? "success" : "muted", plain), w));
					}
					if (rows.length === 0) lines.push(fg("dim", clip("unreported — the plane returned nothing", w)));
					if (tab !== "fiddle") {
						lines.push(
							fg("dim", clip(`reported_by: inferred:name-prefix (degraded until W2886) · rows ${rows.length} · r refresh · Enter fiddle · Esc close`, w)),
						);
					}
					return lines;
				};

				return {
					invalidate() {},
					render(w: number) {
						return render(w);
					},
					handleInput(data: string) {
						if (_keybindings.matches(data, "tui.select.cancel") || data === "q") {
							done();
							return;
						}
						const d = data.trim();
						if (["1", "2", "3", "4", "5"].includes(d)) {
							tab = TABS[Number(d) - 1];
							scroll = 0;
						} else if (data === "r") {
							void refreshFast().then(() => tui.requestRender());
							void refreshFleet().then(() => tui.requestRender());
						} else if (_keybindings.matches(data, "cursor.down") || data === "j") {
							scroll += 1;
						} else if (_keybindings.matches(data, "cursor.up") || data === "k") {
							scroll = Math.max(0, scroll - 1);
						} else if (data === "\r" || data === "\n") {
							let rows: string[][] = [];
							let entities: Array<{ label: string; state: string; task: string; hub: string } | null> = [];
							if (tab === "overview") {
								rows = overviewRows();
								entities = rows.map((r) => ({ label: r[0], state: r[1], task: r[3], hub: r[2] }));
							} else if (tab === "work") {
								rows = workRows();
								entities = rows.map((r) => ({ label: r[0], state: r[1], task: r[4], hub: "local" }));
							} else if (tab === "remote") {
								const rm = remoteRows();
								rows = rm.rows;
								entities = rm.entityOf;
							}
							const idx = Math.min(Math.max(0, rows.length - 1), scroll);
							if (entities[idx]) {
								sel = entities[idx];
								tab = "fiddle";
								scroll = 0;
							}
						}
						tui.requestRender();
					},
				};
			});
		} finally {
			clearInterval(kicker);
			tuiRef = null;
		}
	}

	pi.registerCommand("fleetcockpit", {
		description: "Fleet cockpit: tabs overview·work·local·remote·fiddle, plane-only data",
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			const want = (args ?? "").trim() as Tab;
			await panel(TABS.includes(want) ? want : "overview", ctx);
		},
	});

	// persistent dock line (own widget id — fleet-statusline owns "fleet")
	if (!DOCK_OFF) {
		pi.on("session_start", async (_e, ctx) => {
			dockUi = ctx.ui;
			void refreshFast();
			const dockTick = setInterval(() => void refreshFast(), 30_000);
			dockTick.unref?.();
		});
	}
}
