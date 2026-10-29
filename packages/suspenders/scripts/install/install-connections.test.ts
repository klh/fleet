// W1234 — wireConnections step tests: the ask pauses without --yes, --yes
// writes once at mode 600, the existing file is NEVER overwritten. W2284:
// the universal launchctl face is RETIRED — the step only UNSETS the proxy
// trio in the launchd user domain (owner ruling 2026-10-29: the buckle
// proxy is NOT a system proxy); the runner is injectable so tests never
// touch the host.

import { afterAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultTemplate,
	GUI_PROXY_ASK,
	RETIRED_LAUNCHCTL_KEYS,
	wireConnections,
} from "./install-connections.ts";

const SETENV: string[][] = [];
const recorder = async (pairs: { key: string; value: string }[]) => {
	for (const p of pairs) SETENV.push([p.key, p.value]);
};
const stubResolve = async () => ({
	url: "http://hub.test:4101",
	via: "test-stub",
});

afterAll(() => {
	delete process.env.SUSPENDERS_CONNECTIONS_FILE;
	delete process.env.SUSPENDERS_DEFAULT_HUB;
});

const tmpFile = (): string => {
	const root = mkdtempSync(join(tmpdir(), "wire-conn-"));
	return join(root, "connections.json");
};

test("absent + --yes: writes mode 600 template, unsets the retired proxy trio", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	process.env.SUSPENDERS_DEFAULT_HUB = "TESTHUB";
	SETENV.length = 0;
	const r = await wireConnections(
		{ yes: true } as never,
		recorder,
		stubResolve,
	);
	expect(r.status).toBe("ok");
	expect(statSync(p).mode & 0o777).toBe(0o600);
	// every retired key arrives as an UNSET row — the step never setenvs
	const rows = SETENV.filter(([k]) =>
		(RETIRED_LAUNCHCTL_KEYS as readonly string[]).includes(k),
	);
	expect(rows.map(([k, v]) => [k, v])).toEqual(
		RETIRED_LAUNCHCTL_KEYS.map((k) => [k, ""]),
	);
	// no value rows: nothing in this run may carry a proxy URL
	expect(SETENV.some(([, v]) => v !== "")).toBe(false);
	expect(r.note).toContain("retired");
});

test("existing file: never overwritten, domain still ends clean", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	process.env.SUSPENDERS_DEFAULT_HUB = "TESTHUB";
	writeFileSync(
		p,
		JSON.stringify({ version: 1, default: "TESTHUB", apps: {}, repos: {} }),
	);
	SETENV.length = 0;
	const r = await wireConnections(
		{ yes: true } as never,
		recorder,
		stubResolve,
	);
	expect(r.status).toBe("ok");
	expect(readFileSync(p, "utf8")).toBe(
		JSON.stringify({ version: 1, default: "TESTHUB", apps: {}, repos: {} }),
	);
	expect(SETENV.some(([, v]) => v !== "")).toBe(false);
	expect(r.note).toContain("never overwritten");
});

test("idempotent: the second run converges (same bytes, same unsets)", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	process.env.SUSPENDERS_DEFAULT_HUB = "TESTHUB";
	SETENV.length = 0;
	await wireConnections({ yes: true } as never, recorder, stubResolve);
	const before = readFileSync(p, "utf8");
	const first = JSON.stringify(SETENV);
	const second = await wireConnections(
		{ yes: true } as never,
		recorder,
		stubResolve,
	);
	expect(readFileSync(p, "utf8")).toBe(before);
	expect(JSON.stringify(SETENV.slice(SETENV.length / 2))).toBe(first);
	expect(second.note).toContain("never overwritten");
});

test("absent without --yes: pauses with the exact ASK, writes nothing, domain still cleared", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	process.env.SUSPENDERS_DEFAULT_HUB = "TESTHUB";
	SETENV.length = 0;
	const r = await wireConnections(
		{ yes: false } as never,
		recorder,
		stubResolve,
	);
	expect(r.status).toBe("need_user_action");
	expect(r.note).toContain(GUI_PROXY_ASK);
	expect(existsSync(p)).toBe(false);
	// W2284: the pause path STILL reclaims the launchd domain (hygiene is
	// unconditional), and every row is an unset
	expect(SETENV.length).toBe(RETIRED_LAUNCHCTL_KEYS.length);
	expect(SETENV.every(([, v]) => v === "")).toBe(true);
});

test("defaultTemplate: every GUI app + codex default-ON (W1260.1, CONNECT relay)", () => {
	const t = defaultTemplate("hub");
	expect(t.apps?.chatgpt?.enabled).toBe(true);
	expect(t.apps?.claude?.enabled).toBe(true);
	expect(t.apps?.vscode?.enabled).toBe(true);
	expect(t.apps?.codex?.enabled).toBe(true);
});

test("unparseable existing file is a truthful failed row, never a rewrite", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	writeFileSync(p, "{not json");
	SETENV.length = 0;
	const r = await wireConnections(
		{ yes: true } as never,
		recorder,
		stubResolve,
	);
	expect(r.status).toBe("failed");
	expect(readFileSync(p, "utf8")).toBe("{not json");
});

test("unresolved hub: the clear is unconditional, the step degrades honestly", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	process.env.SUSPENDERS_DEFAULT_HUB = "TESTHUB";
	SETENV.length = 0;
	const r = await wireConnections(
		{ yes: true } as never,
		recorder,
		async () => null,
	);
	expect(r.status).toBe("ok");
	expect(statSync(p).mode & 0o777).toBe(0o600);
	expect(SETENV.length).toBe(RETIRED_LAUNCHCTL_KEYS.length);
	expect(r.note).toContain("UNSET");
});
