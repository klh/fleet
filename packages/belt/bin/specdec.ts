#!/usr/bin/env bun
// bin/specdec.ts — W242: speculative decoding (MTP) as a catalog dimension.
// MTP lives in the CHECKPOINT (rapid-mlx auto-detects `mtp.*` weights and
// uses them; mlx_lm strips them at load), so capability is catalog data, not
// engine config. Two verbs:
//
//   bun bin/specdec.ts check [--hub DIR]
//     Registry declaration vs snapshot reality: is each served checkpoint
//     MTP-capable, and does its row admit it. Drift rows print.
//
//   bun bin/specdec.ts scan [--api URL] [--limit N]
//     Live mlx-community sweep for MTP checkpoints: phantom-filtered (real
//     bytes off the tree endpoint), 30B-class gated, tried-memo skipped.
//     REBENCH-DUE prints the exact fleet-refresh ab command per unique slot.
//
// Verdict contract: both verbs end with ONE machine-parseable final line —
//   SPECDEC VERDICT: REBENCH-DUE — <why>   |   SPECDEC VERDICT: NOT-DUE — <why>
// Mission gate: the 4B W115 verdict does not extrapolate; W535's 30B+ MTP
// losses were DENSE checkpoints (confounded), so the MoE×MTP cell is the
// open question the scan watches for.
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readdirSync,
	readSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SPECIALISTS, type Specialist } from "./registry.ts";
import type { TriedRow } from "./fleet-refresh.ts";

// ~30B at 4-bit ≈ 17GB of weights; 15GB is the floor that still admits
// 30B-class 4bit/oQ4e rows and rejects sub-GB conversion placeholders.
export const MIN_REAL_BYTES = 15e9;
// Candidate rows carry GB — the same floor in candidate units.
export const MIN_REAL_GB = MIN_REAL_BYTES / 1e9;

// The mission's "30B+ resident": ram_gb is the registry's size currency and
// 15GB ≈ 30B @ 4-bit. A challenged slot must clear this to count as the cell.
export const SPECDEC_MIN_RAM_GB = 15;

// ─── class tokens (pure) ───

// "…35B-A3B…" → 35 · "…27b…" → 27 · "…4bit…"/"mxfp8" → null: the B must NOT
// start a word, so "4bit" can never read as a 4-billion token.
export function sizeTokenB(id: string): number | null {
	const m = id.match(/(\d+(?:\.\d+)?)B(?![a-z])/i);
	return m ? Number(m[1]) : null;
}

// MoE marker: "35B-A3B" → true · "27B" (dense) → false · no size token → null.
export function moeToken(id: string): boolean | null {
	if (/A\d+(?:\.\d+)?B(?![a-z])/i.test(id)) return true;
	return sizeTokenB(id) === null ? null : false;
}

// ─── snapshot MTP detection (checkpoint-derived truth) ───

/** model.safetensors.index.json weight names → mtp.* present? null = no index. */
export function mtpFromIndex(indexPath: string): boolean | null {
	try {
		const doc = JSON.parse(readFileSync(indexPath, "utf8")) as {
			weight_map?: Record<string, string>;
		};
		if (!doc.weight_map) return null;
		return Object.keys(doc.weight_map).some((k) => k.startsWith("mtp."));
	} catch {
		return null;
	}
}

/** Unsharded checkpoints: the safetensors header IS the weight-name list. */
export function safetensorsHeaderMtp(path: string): boolean | null {
	try {
		const fd = openSync(path, "r");
		try {
			const lenBuf = Buffer.alloc(8);
			readSync(fd, lenBuf, 0, 8, 0);
			const headerLen = Number(lenBuf.readBigUInt64LE(0));
			if (headerLen <= 0 || headerLen > 64e6) return null;
			const buf = Buffer.alloc(headerLen);
			readSync(fd, buf, 0, headerLen, 8);
			const header = JSON.parse(buf.toString("utf8")) as Record<
				string,
				unknown
			>;
			return Object.keys(header).some((k) => k.startsWith("mtp."));
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** MTP capability of the locally cached snapshot: null = never pulled. */
export function snapshotMtp(hub: string, modelId: string): boolean | null {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || slash === modelId.length - 1) return null;
	const dir = join(
		hub,
		`models--${modelId.slice(0, slash)}--${modelId.slice(slash + 1)}`,
		"snapshots",
	);
	if (!existsSync(dir)) return null;
	let snaps: string[] = [];
	try {
		snaps = readdirSync(dir);
	} catch {
		return null;
	}
	for (const s of snaps) {
		const sp = join(dir, s);
		const byIndex = mtpFromIndex(join(sp, "model.safetensors.index.json"));
		if (byIndex !== null) return byIndex;
		const shards = readdirSync(sp).filter((f) => f.endsWith(".safetensors"));
		if (shards.length > 0) return safetensorsHeaderMtp(join(sp, shards[0]));
	}
	return null;
}

// ─── verdict assembly (pure) ───

export interface ResidentRow {
	port: number;
	model: string;
	ram_gb: number;
	declared: boolean; // registry spec_dec === "mtp"
	snapshot: boolean | null; // mtp.* weights in the served snapshot
}

export interface MtpCandidate {
	id: string;
	gb: number; // real safetensors bytes from the tree endpoint
	sizeB: null | number; // size-class token, e.g. 35 for the 35B class
	moe: null | boolean; // A<n>B density token present
}

export interface SpecdecVerdict {
	due: boolean;
	why: string;
	residentDrift: ResidentRow[]; // declared ≠ snapshot on a ≥15GB slot
	challengers: MtpCandidate[]; // real, untried, 30B-class MTP checkpoints
}

export function rebenchDue(
	residents: ResidentRow[],
	candidates: MtpCandidate[],
	tried: TriedRow[],
): SpecdecVerdict {
	const drift = residents.filter(
		(r) =>
			r.ram_gb >= SPECDEC_MIN_RAM_GB &&
			r.snapshot !== null &&
			r.snapshot !== r.declared,
	);
	const triedIds = new Set(tried.map((t) => t.id));
	const challengers = candidates.filter(
		(c) =>
			c.gb >= MIN_REAL_GB &&
			(c.sizeB === null || c.sizeB >= 30) &&
			!triedIds.has(c.id),
	);
	const due = drift.length > 0 || challengers.length > 0;
	const why = drift.length
		? `${drift.length} resident(s) with live MTP weights on a ≥15GB slot`
		: challengers.length
			? `${challengers.length} real untried 30B-class MTP checkpoint(s) upstream`
			: "no live-MTP ≥15GB resident, no untried challenger";
	return { due, why, residentDrift: drift, challengers };
}

// ─── HF scan (networked) ───

interface TreeFile {
	path: string;
	size?: number;
	lfs?: { size?: number };
}

/** Real safetensors bytes for one model via the tree endpoint (lfs.size is
 *  the honest number; files_metadata sizes read 0 on conversion repos). */
async function treeBytes(
	api: string,
	id: string,
	f: typeof fetch = fetch,
): Promise<number> {
	const r = await f(`${api}/api/models/${id}/tree/main?recursive=true`);
	if (!r.ok) return 0;
	const files = (await r.json()) as TreeFile[];
	return files
		.filter((x) => x.path.endsWith(".safetensors"))
		.reduce((a, x) => a + (x.lfs?.size || x.size || 0), 0);
}

/** MTP ids on mlx-community (id-substring search, case-insensitive). */
export async function mtpSearch(
	api: string,
	limit: number,
	f: typeof fetch = fetch,
): Promise<string[]> {
	const r = await f(
		`${api}/api/models?author=mlx-community&search=mtp&limit=${limit}`,
	);
	if (!r.ok) throw new Error(`hf search ${r.status}`);
	const doc = (await r.json()) as { id: string }[];
	return doc.map((x) => x.id);
}

/** Live mlx-community sweep → phantom-filtered candidate rows. */
export async function scanCandidates(
	api: string,
	limit: number,
	f: typeof fetch = fetch,
): Promise<MtpCandidate[]> {
	const ids = await mtpSearch(api, limit, f);
	const out: MtpCandidate[] = [];
	for (const id of ids) {
		const gb = (await treeBytes(api, id, f)) / 1e9;
		out.push({
			id,
			gb: +gb.toFixed(2),
			sizeB: sizeTokenB(id),
			moe: moeToken(id),
		});
	}
	return out;
}

// ─── CLI ───

const TRIED_JSON = join(import.meta.dir, "../bench/tried.json");

function hubArg(argv: string[]): string {
	const i = argv.indexOf("--hub");
	if (i >= 0 && argv[i + 1]) return argv[i + 1];
	return join(homedir(), ".cache", "huggingface", "hub");
}

function triedRows(): TriedRow[] {
	try {
		return JSON.parse(readFileSync(TRIED_JSON, "utf8")) as TriedRow[];
	} catch {
		return [];
	}
}

/** Printed hint only — slot swap stays a manual registry step (W295 law). */
export function suggestSlot(
	c: MtpCandidate,
	sp: Specialist[],
): Specialist | undefined {
	if (c.sizeB === null) return undefined;
	const big = sp.filter(
		(s) => s.ram_gb >= SPECDEC_MIN_RAM_GB && moeToken(s.model) === c.moe,
	);
	if (big.length === 0) return undefined;
	return big.reduce((best, s) =>
		Math.abs((sizeTokenB(s.model) ?? 0) - c.sizeB) <
		Math.abs((sizeTokenB(best.model) ?? 0) - c.sizeB)
			? s
			: best,
	);
}

function cmdCheck(hub: string): number {
	const rows: ResidentRow[] = SPECIALISTS.map((s) => ({
		port: s.port,
		model: s.model,
		ram_gb: s.ram_gb,
		declared: s.spec_dec === "mtp",
		snapshot: snapshotMtp(hub, s.model),
	}));
	console.log(
		["port", "model", "GB", "declared", "snapshot-mtp", "note"].join(" | "),
	);
	for (const r of rows) {
		const drift =
			r.ram_gb >= SPECDEC_MIN_RAM_GB &&
			r.snapshot !== null &&
			r.snapshot !== r.declared;
		console.log(
			[
				String(r.port),
				r.model,
				String(r.ram_gb),
				String(r.declared),
				r.snapshot === null ? "not-downloaded" : String(r.snapshot),
				drift ? "DRIFT" : "",
			].join(" | "),
		);
	}
	const v = rebenchDue(rows, [], triedRows());
	console.log(
		`SPECDEC VERDICT: ${v.due ? "REBENCH-DUE" : "NOT-DUE"} — ${v.why}`,
	);
	return 0;
}

async function cmdScan(api: string, limit: number): Promise<number> {
	const cands = await scanCandidates(api, limit);
	const v = rebenchDue([], cands, triedRows());
	console.log(`mlx-community MTP sweep (${api}, limit ${limit}):`);
	for (const c of v.challengers) {
		const slot = suggestSlot(c, SPECIALISTS);
		console.log(`  ${c.id} | ${c.gb}GB | ${c.sizeB ?? "?"}B`);
		if (slot) {
			console.log(
				`    → same-class slot :${slot.port}: fleet-refresh ab --candidate ${c.id} --incumbent-port ${slot.port} --incumbent-model ${slot.model} --keep`,
			);
		}
	}
	console.log(
		`SPECDEC VERDICT: ${v.due ? "REBENCH-DUE" : "NOT-DUE"} — ${v.why}`,
	);
	return 0;
}

async function main(argv: string[]): Promise<number> {
	const cmd = argv[0] ?? "";
	const get = (f: string) => {
		const i = argv.indexOf(f);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (cmd === "check") {
		return cmdCheck(hubArg(argv));
	}
	if (cmd === "scan") {
		const api = get("--api") ?? "https://huggingface.co";
		const limit = Number(get("--limit") ?? 100);
		return cmdScan(api, limit);
	}
	console.error(
		"usage: bun bin/specdec.ts <check|scan> [--hub DIR] [--api URL] [--limit N]",
	);
	return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
