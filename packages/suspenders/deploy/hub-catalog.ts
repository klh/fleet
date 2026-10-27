// W1711: operator-invoked reconciliation of one hub's explicit upstream
// groups against authenticated provider catalogs. check is a dry run that
// yields a reviewable plan; apply lands exactly that plan over the exact
// stack bytes it was computed from (sha256 CAS under the stack file lock),
// at 0600 with a byte-identical backup and an in-memory restore. A stale
// alias is flagged or, when asked, removed — never re-pointed elsewhere.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	type ModelCapabilityRecord,
	readCapabilitySnapshot,
	validRecord,
	type WireEndpoint,
	writeCapabilitySnapshot,
} from "@klh/belt/bin/model-capabilities.ts";
import {
	atomicWrite0600,
	modeIs0600,
} from "@klh/kernel/src/kernel.atomic.module.ts";
import { FileLockUnavailable, withFileLock } from "../hooks/lib/file-lock.ts";
import type { HubProfile, StackConfig } from "../hooks/lib/stack-config.ts";
import {
	type CatalogListing,
	catalogTarget,
	fetchCatalog,
	type ListingFailure,
	listedCapability,
	type Unverifiable,
} from "./hub-catalog-fetch.ts";

export type RowVerdict = "present" | "stale" | Unverifiable | ListingFailure;
export type WireVerdict = "supported" | "unsupported" | "unknown";

export interface RowReport {
	group: string;
	index: number;
	model: string;
	url: string;
	verdict: RowVerdict;
	detail: string | null;
	source: string | null;
	observed_at: string | null;
	wire: WireVerdict;
	flagged: boolean;
}

export type PlanOp = "flag" | "unflag" | "remove";

export interface PlanAction {
	op: PlanOp;
	group: string;
	index: number;
	model: string;
	url: string;
	source: string;
	observed_at: string;
}

export interface CatalogPlan {
	version: 1;
	hub: string;
	stack_path: string;
	stack_sha256: string;
	generated_at: string;
	actions: PlanAction[];
	capabilities: ModelCapabilityRecord[];
}

/** The stack moved (or another writer holds it) — nothing was written. */
export class CatalogConflict extends Error {}

const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DIALECT_WIRES = new Map<unknown, WireEndpoint[]>([
	["anthropic", ["/v1/messages"]],
	["openai", ["/v1/chat/completions", "/v1/responses"]],
]);

const sha256 = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

/** Buckle's served id: the row model, else the group name. */
const effectiveModel = (row: Record<string, unknown>, group: string): string =>
	typeof row.model === "string" ? row.model : group;

const rowUrl = (row: Record<string, unknown>): string =>
	typeof row.url === "string" ? row.url : "";

/** Parse errors echo source fragments, and stack.json may hold inline keys. */
const parseStack = (text: string): StackConfig => {
	try {
		return JSON.parse(text) as StackConfig;
	} catch {
		throw new Error("stack file is not valid JSON");
	}
};

/** Report-only: does the published endpoint set carry this row's dialect? */
const wireVerdict = (
	dialect: unknown,
	record: ModelCapabilityRecord | null,
): WireVerdict => {
	const published = record?.endpoints.value;
	const needs = DIALECT_WIRES.get(dialect);
	if (!published || !needs) return "unknown";
	return needs.some((wire) => published.includes(wire))
		? "supported"
		: "unsupported";
};

/** One fetch per (catalog, credential, headers); unverifiable rows never fetch. */
const listingFor = (
	hub: HubProfile,
	row: Record<string, unknown>,
	listings: Map<string, Promise<CatalogListing>>,
	fetcher?: typeof fetch,
): Promise<CatalogListing> | Unverifiable => {
	const target = catalogTarget(hub, row);
	if (target.kind === "unverifiable") return target.reason;
	const key = JSON.stringify([target.kind, target.source, target.keyFile, target.headers]);
	const cached = listings.get(key) ?? fetchCatalog(target, fetcher);
	listings.set(key, cached);
	return cached;
};

type RowBase = Pick<RowReport, "group" | "index" | "model" | "url" | "flagged">;

const reconcileRow = async (
	hub: HubProfile,
	base: RowBase,
	row: Record<string, unknown>,
	listings: Map<string, Promise<CatalogListing>>,
	fetcher?: typeof fetch,
): Promise<{ report: RowReport; record: ModelCapabilityRecord | null }> => {
	const unknownRow = { detail: null, source: null, observed_at: null, wire: "unknown" as const };
	const pending = listingFor(hub, row, listings, fetcher);
	if (typeof pending === "string")
		return { report: { ...base, ...unknownRow, verdict: pending }, record: null };
	const listing = await pending;
	if (listing.state !== "listed") {
		const failure = { verdict: listing.state, detail: listing.detail, source: listing.source };
		return { report: { ...base, ...unknownRow, ...failure }, record: null };
	}
	const present = listing.rows.has(base.model);
	const record = present ? listedCapability(listing, base.model) : null;
	const verdict: RowVerdict = present ? "present" : "stale";
	const evidence = { source: listing.source, observed_at: listing.observedAt };
	const wire = wireVerdict(row.dialect, record);
	return { report: { ...base, verdict, detail: null, ...evidence, wire }, record };
};

/** Flag a stale row once; remove only when asked and never a group's last row
 *  (an emptied group would let a base or generated ladder substitute). */
const actionFor = (
	report: RowReport,
	removeStale: boolean,
	emptiesGroup: boolean,
): PlanOp | null => {
	if (report.verdict === "present") return report.flagged ? "unflag" : null;
	if (report.verdict !== "stale") return null;
	if (removeStale && !emptiesGroup) return "remove";
	return report.flagged ? null : "flag";
};

const planActions = (reports: RowReport[], removeStale: boolean): PlanAction[] =>
	reports.flatMap((report) => {
		const emptiesGroup = reports.every(
			(other) => other.group !== report.group || other.verdict === "stale",
		);
		const op = actionFor(report, removeStale, emptiesGroup);
		if (!op || !report.source || !report.observed_at) return [];
		const { group, index, model, url } = report;
		return [{ op, group, index, model, url, source: report.source, observed_at: report.observed_at }];
	});

export interface CatalogCheck {
	reports: RowReport[];
	plan: CatalogPlan;
}

/** Dry run: one read of the stack bytes, provider GETs, no writes. */
export async function checkHubCatalog(options: {
	hub: string;
	stackPath: string;
	removeStale?: boolean;
	fetcher?: typeof fetch;
}): Promise<CatalogCheck> {
	const stackPath = resolve(options.stackPath);
	const bytes = readFileSync(stackPath);
	const stack = parseStack(bytes.toString("utf8"));
	const hub = stack.hubs?.[options.hub];
	if (!hub) throw new Error(`unknown hub ${options.hub}`);
	const listings = new Map<string, Promise<CatalogListing>>();
	const reports: RowReport[] = [];
	const records = new Map<string, ModelCapabilityRecord>();
	for (const [group, rows] of Object.entries(hub.upstreams?.groups ?? {}))
		for (const [index, row] of rows.entries()) {
			const flagged = row.catalog_stale !== undefined;
			const base = { group, index, model: effectiveModel(row, group), url: rowUrl(row), flagged };
			const result = await reconcileRow(hub, base, row, listings, options.fetcher);
			reports.push(result.report);
			if (result.record)
				records.set(`${result.record.provider}\u0000${result.record.modelId}`, result.record);
		}
	const actions = planActions(reports, options.removeStale === true);
	const generated_at = new Date().toISOString();
	const identity = { hub: options.hub, stack_path: stackPath, stack_sha256: sha256(bytes) };
	const plan: CatalogPlan = { version: 1, ...identity, generated_at, actions, capabilities: [...records.values()] };
	return { reports, plan };
}

const PLAN_OPS = new Set<unknown>(["flag", "unflag", "remove"]);
const ACTION_TEXT = ["group", "model", "url", "source", "observed_at"];

const validAction = (value: unknown): value is PlanAction => {
	const action = value as Record<string, unknown> | null;
	return (
		!!action &&
		PLAN_OPS.has(action.op) &&
		Number.isSafeInteger(action.index) &&
		Number(action.index) >= 0 &&
		ACTION_TEXT.every((field) => typeof action[field] === "string" && action[field] !== "")
	);
};

/** A reviewed plan applies only to the stack file it was made from, within a day. */
export function validatePlan(value: unknown, stackPath: string, now = Date.now()): CatalogPlan {
	const plan = value as Partial<CatalogPlan> | null;
	const valid =
		plan?.version === 1 &&
		typeof plan.hub === "string" &&
		plan.hub !== "" &&
		plan.stack_path === resolve(stackPath) &&
		/^[0-9a-f]{64}$/.test(String(plan.stack_sha256)) &&
		Array.isArray(plan.actions) &&
		plan.actions.every(validAction) &&
		Array.isArray(plan.capabilities) &&
		plan.capabilities.every(validRecord);
	if (!valid) throw new Error("catalog plan is malformed or was made for another stack file");
	const checked = plan as CatalogPlan;
	const age = now - Date.parse(checked.generated_at);
	if (!(age >= 0 && age <= PLAN_MAX_AGE_MS)) throw new Error("catalog plan is older than 24h; re-run check");
	const rows = new Set(checked.actions.map((action) => `${action.group}\u0000${action.index}`));
	if (rows.size !== checked.actions.length) throw new Error("catalog plan names a row twice");
	return checked;
}

/** Mutates the parsed stack; every action must still name the row it reviewed. */
const applyActions = (stack: StackConfig, plan: CatalogPlan): void => {
	const groups = stack.hubs?.[plan.hub]?.upstreams?.groups ?? {};
	for (const action of plan.actions) {
		const row = groups[action.group]?.[action.index];
		if (!row || effectiveModel(row, action.group) !== action.model || rowUrl(row) !== action.url)
			throw new CatalogConflict(`plan row ${action.group}[${action.index}] does not match the stack`);
		if (action.op === "flag")
			row.catalog_stale = { source: action.source, observed_at: action.observed_at };
		if (action.op === "unflag") Reflect.deleteProperty(row, "catalog_stale");
	}
	const removals = plan.actions
		.filter((action) => action.op === "remove")
		.sort((a, b) => b.index - a.index);
	for (const action of removals) groups[action.group]?.splice(action.index, 1);
	for (const action of removals)
		if (!groups[action.group]?.length)
			throw new CatalogConflict(`plan would empty group ${action.group}; edit it by hand`);
};

const landed = (path: string, text: string): boolean =>
	readFileSync(path, "utf8") === text && modeIs0600(statSync(path).mode);

/** Under the stack lock: CAS, byte-identical backup, atomic 0600 write, then
 *  verify — a write that does not read back is replaced by the checked bytes. */
const writeStack = (plan: CatalogPlan, stackPath: string): string | null => {
	if (lstatSync(stackPath).isSymbolicLink())
		throw new Error("stack path is a symlink; apply writes regular files only");
	const original = readFileSync(stackPath);
	if (sha256(original) !== plan.stack_sha256)
		throw new CatalogConflict("stack changed since check; nothing written — re-run check");
	if (!plan.actions.length) return null;
	const text = original.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(original)) throw new Error("stack file is not UTF-8 text");
	const stack = parseStack(text);
	applyActions(stack, plan);
	const next = `${JSON.stringify(stack, null, "\t")}\n`;
	const backup = `${stackPath}.pre-catalog-${plan.stack_sha256.slice(0, 12)}.bak`;
	if (!existsSync(backup)) atomicWrite0600(backup, text);
	if (!readFileSync(backup).equals(original))
		throw new Error("backup does not hold the checked stack bytes; nothing written");
	if (sha256(readFileSync(stackPath)) !== plan.stack_sha256)
		throw new CatalogConflict("stack changed during apply; nothing written");
	atomicWrite0600(stackPath, next);
	if (landed(stackPath, next)) return backup;
	atomicWrite0600(stackPath, text);
	throw new Error(
		landed(stackPath, text)
			? "stack write did not verify; checked bytes restored"
			: `stack write and restore did not verify; recover from ${backup}`,
	);
};

export interface ApplyResult {
	changed: boolean;
	backup: string | null;
	actions: number;
	capabilities: number;
}

/** Lands a reviewed plan: the stack under CAS first, then the capability
 *  merge — a failed merge is re-run as a fresh check with no stack actions. */
export async function applyCatalogPlan(options: {
	plan: unknown;
	stackPath: string;
	capabilitiesPath: string;
	now?: number;
}): Promise<ApplyResult> {
	const stackPath = resolve(options.stackPath);
	const plan = validatePlan(options.plan, stackPath, options.now);
	const snapshot = await readCapabilitySnapshot(options.capabilitiesPath);
	if (snapshot.state === "invalid")
		throw new Error("capability snapshot is invalid; refusing to replace it");
	let backup: string | null;
	try {
		backup = withFileLock(stackPath, () => writeStack(plan, stackPath));
	} catch (error) {
		if (error instanceof FileLockUnavailable)
			throw new CatalogConflict("stack lock is held by another writer; nothing written");
		throw error;
	}
	for (const record of plan.capabilities) snapshot.registry.upsert(record);
	if (plan.capabilities.length)
		await writeCapabilitySnapshot(options.capabilitiesPath, snapshot.registry);
	const counts = { actions: plan.actions.length, capabilities: plan.capabilities.length };
	return { changed: backup !== null, backup, ...counts };
}
