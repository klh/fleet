// deploy/hub-catalog-fixture.ts — W1711 helpers for hub-catalog.e2e.ts
// (shape law: the spec file carries only imports and test registrations).
// Fixtures live under the OS tmpdir; catalogs come from in-process mock
// fetchers — no network, no machine stack, no real credential.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	groupWireEndpoints,
	readCapabilitySnapshot,
} from "@klh/belt/bin/model-capabilities.ts";
import type { CatalogPlan, PlanOp, RowReport } from "./hub-catalog.ts";

/** Synthetic credential: it may reach the provider request and nothing else. */
export const KEY_VALUE = "synthetic-catalog-credential-w1711";

const CLI = fileURLToPath(new URL("./hub-catalog-sync.ts", import.meta.url));
const LOCAL_ROW = {
	url: "http://127.0.0.1:4000",
	dialect: "anthropic",
	model: "local-reason",
};

const copilotRow = (model: string, dialect: string) => ({
	url: "https://api.githubcopilot.com",
	dialect,
	model,
	api_key_env: "GITHUB_COPILOT_PAT",
	adapter_config: {
		headers: {
			"copilot-integration-id": "vscode-chat",
			...(dialect === "anthropic"
				? { "anthropic-beta": "context-1m-2025-08-07" }
				: {}),
		},
	},
});

const stackDoc = (keyFile: string) => ({
	version: "2.0.0",
	hubs: {
		desk: {
			secrets: { upstream_keys: { GITHUB_COPILOT_PAT: keyFile } },
			upstreams: {
				groups: {
					"claude-sonnet-5": [copilotRow("claude-sonnet-5.5", "anthropic")],
					"gpt-6.1-sol": [copilotRow("gpt-6.1-sol", "openai")],
					"grok-4.7": [copilotRow("grok-4.7", "anthropic")],
					"claude-old": [copilotRow("claude-old-4", "anthropic"), LOCAL_ROW],
					"gpt-legacy": [copilotRow("gpt-4.9-legacy", "openai")],
					local: [LOCAL_ROW],
					unkeyed: [
						{ ...copilotRow("claude-sonnet-5.5", "anthropic"), api_key_env: "UNSET_KEY" },
					],
				},
			},
		},
		nas: {
			deploy: { ssh: "lane@example.invalid" },
			secrets: { upstream_keys: { GITHUB_COPILOT_PAT: keyFile } },
			upstreams: {
				groups: { "claude-sonnet-5": [copilotRow("claude-sonnet-5.5", "anthropic")] },
			},
		},
	},
});

export interface StackFixture {
	dir: string;
	stackPath: string;
	keyFile: string;
	capabilitiesPath: string;
}

/** A 0600 key file and a 0600 two-hub stack; HOME for CLI runs is dir/home. */
export function makeFixture(): StackFixture {
	const dir = mkdtempSync(join(tmpdir(), "w1711-hub-catalog-"));
	const keyFile = join(dir, "copilot.key");
	writeFileSync(keyFile, `${KEY_VALUE}\n`, { mode: 0o600 });
	const stackPath = join(dir, "stack.json");
	const text = `${JSON.stringify(stackDoc(keyFile), null, "\t")}\n`;
	writeFileSync(stackPath, text, { mode: 0o600 });
	const capabilitiesPath = join(dir, "home", ".claude", "local-llm", "model-capabilities.json");
	return { dir, stackPath, keyFile, capabilitiesPath };
}

export const dropFixture = (f: StackFixture): void =>
	rmSync(f.dir, { recursive: true, force: true });

/** Published Copilot rows: three live models plus near-miss ids that must
 *  never stand in for the stale aliases they resemble. */
export const CATALOG_ROWS: unknown[] = [
	{
		id: "claude-sonnet-5.5",
		supported_endpoints: ["/v1/messages", "/chat/completions"],
		capabilities: {
			limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
			supports: { tool_calls: true, streaming: true, structured_outputs: false },
		},
	},
	{
		id: "gpt-6.1-sol",
		supported_endpoints: ["/responses"],
		capabilities: { supports: { tool_calls: true, streaming: true } },
	},
	{ id: "grok-4.7", supported_endpoints: ["/responses"] },
	{ id: "claude-old-4.1", supported_endpoints: ["/v1/messages"] },
	{ id: "gpt-4.9-legacy-preview" },
];

export type CatalogReply = "ok" | "empty" | "garbage" | "oversize" | "throw" | number;

export interface FetchCall {
	url: string;
	headers: Record<string, string>;
}

/** Failure bodies and errors echo the credential; callers must never relay them. */
export function catalogFetcher(reply: CatalogReply = "ok", rows = CATALOG_ROWS) {
	const calls: FetchCall[] = [];
	const fetcher = (async (input: unknown, init?: RequestInit) => {
		const headers = { ...(init?.headers as Record<string, string> | undefined) };
		calls.push({ url: String(input), headers });
		if (reply === "throw") throw new Error(`connect failed ${KEY_VALUE}`);
		if (typeof reply === "number") return new Response(`denied ${KEY_VALUE}`, { status: reply });
		if (reply === "garbage") return new Response(`not json ${KEY_VALUE}`);
		if (reply === "empty") return Response.json({ data: [] });
		const pad = reply === "oversize" ? "x".repeat(1024 * 1024) : "";
		return Response.json({ data: rows, pad });
	}) as unknown as typeof fetch;
	return { fetcher, calls };
}

export const PROVIDER_FAILURES: Array<{ reply: CatalogReply; detail: string }> = [
	{ reply: 500, detail: "HTTP 500" },
	{ reply: "throw", detail: "request failed or timed out" },
	{ reply: "oversize", detail: "catalog exceeds 1 MiB" },
	{ reply: "empty", detail: "catalog lists no models" },
	{ reply: "garbage", detail: "catalog body unreadable" },
];

/** "group[index]" → "verdict wire" for every reported row. */
export const verdicts = (reports: RowReport[]): Record<string, string> =>
	Object.fromEntries(reports.map((r) => [`${r.group}[${r.index}]`, `${r.verdict} ${r.wire}`]));

export const ops = (plan: CatalogPlan): string[] =>
	plan.actions.map((action) => `${action.op} ${action.group}[${action.index}]`);

export const reportOf = (reports: RowReport[], group: string, index = 0) =>
	reports.find((report) => report.group === group && report.index === index);

type Row = Record<string, unknown>;
type StackDoc = { hubs: Record<string, { upstreams: { groups: Record<string, Row[]> } }> };

export const readText = (path: string): string => readFileSync(path, "utf8");
export const stackBytes = (f: StackFixture): string => readText(f.stackPath);
const readStack = (f: StackFixture): StackDoc => JSON.parse(stackBytes(f));

export const groupRows = (f: StackFixture, group: string): Row[] =>
	readStack(f).hubs.desk?.upstreams.groups[group] ?? [];

export const rowAt = (f: StackFixture, group: string, index = 0): Row | undefined =>
	groupRows(f, group)[index];

export const models = (f: StackFixture, group: string): unknown[] =>
	groupRows(f, group).map((row) => row.model);

/** The persisted capability snapshot, joined over one desk group's rows. */
export async function snapshotWire(f: StackFixture, group: string) {
	const snapshot = await readCapabilitySnapshot(f.capabilitiesPath);
	const wire = groupWireEndpoints(groupRows(f, group), snapshot.registry, 3_600_000);
	return { state: snapshot.state, wire };
}

/** The stack minus every catalog_stale flag — what apply must leave untouched. */
export const stripFlags = (text: string): unknown =>
	JSON.parse(text, (key, value) => (key === "catalog_stale" ? undefined : value));

export const listDir = (f: StackFixture): string[] => readdirSync(f.dir).sort();

/** Every fixture file whose bytes carry the needle, relative to the fixture. */
export const filesContaining = (f: StackFixture, needle: string): string[] =>
	readdirSync(f.dir, { recursive: true, encoding: "utf8" })
		.map((name) => join(f.dir, name))
		.filter((path) => statSync(path).isFile() && readText(path).includes(needle))
		.map((path) => relative(f.dir, path))
		.sort();

export const fileMode = (path: string): number => statSync(path).mode & 0o777;

/** A group/world-readable key is refused before any request is made. */
export const loosenKey = (f: StackFixture): void => chmodSync(f.keyFile, 0o644);

/** An operator edit landing between check and apply; returns the new bytes. */
export function touchStack(f: StackFixture): string {
	const doc = readStack(f);
	const desk = doc.hubs.desk;
	if (desk) desk.upstreams.groups["operator-added"] = [LOCAL_ROW];
	const text = `${JSON.stringify(doc, null, "\t")}\n`;
	writeFileSync(f.stackPath, text);
	return text;
}

/** Another writer holding the stack lock (withFileLock's mkdir primitive). */
export const holdLock = (f: StackFixture): void => mkdirSync(`${f.stackPath}.lock`);

export function writePlan(f: StackFixture, plan: unknown): string {
	const path = join(f.dir, "plan.json");
	writeFileSync(path, JSON.stringify(plan), { mode: 0o600 });
	return path;
}

/** A reviewed plan whose rows now name other models (never a substitution). */
export function retarget(plan: CatalogPlan, group: string, model: string): CatalogPlan {
	const next = structuredClone(plan);
	for (const action of next.actions) if (action.group === group) action.model = model;
	return next;
}

export function withOp(plan: CatalogPlan, group: string, op: PlanOp): CatalogPlan {
	const next = structuredClone(plan);
	for (const action of next.actions) if (action.group === group) action.op = op;
	return next;
}

export function duplicateFirst(plan: CatalogPlan): CatalogPlan {
	const next = structuredClone(plan);
	const first = next.actions[0];
	if (first) next.actions.push(structuredClone(first));
	return next;
}

export const planWith = (plan: CatalogPlan, field: keyof CatalogPlan, value: unknown) =>
	({ ...structuredClone(plan), [field]: value }) as unknown;

/** The CLI over the fixture stack; HOME scopes the capability snapshot. */
export function runSyncCli(f: StackFixture, args: string[]) {
	const env = { ...process.env, KLH_STACK: f.stackPath, HOME: join(f.dir, "home") };
	const run = spawnSync("bun", [CLI, ...args], { env, encoding: "utf8", timeout: 30_000 });
	return { status: run.status, out: `${run.stdout}${run.stderr}` };
}
