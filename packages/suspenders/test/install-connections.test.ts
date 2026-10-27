// W1234 — wireConnections step tests: the ask pauses without --yes, --yes
// writes once at mode 600, the existing file is NEVER overwritten, the
// launchctl face is injectable (tests never touch the host).
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "bun:test";
import {
	defaultTemplate,
	GUI_PROXY_ASK,
	wireConnections,
	type LaunchctlRun,
} from "../scripts/install-connections.ts";

const SETENV: string[][] = [];
const recorder: LaunchctlRun = async (pairs) => {
	for (const p of pairs) SETENV.push([p.key, p.value]);
};

afterAll(() => {
	delete process.env.SUSPENDERS_CONNECTIONS_FILE;
	delete process.env.SUSPENDERS_DEFAULT_HUB;
	delete process.env.SUSPENDERS_HUB_TESTHUB_URL;
});

const tmpFile = (): string => {
	const root = mkdtempSync(join(tmpdir(), "wire-conn-"));
	return join(root, "connections.json");
};

test("absent + --yes: writes mode 600, applies the launchctl face, prints undo", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	process.env.SUSPENDERS_DEFAULT_HUB = "TESTHUB";
	process.env.SUSPENDERS_HUB_TESTHUB_URL = "http://hub.test:4101";
	SETENV.length = 0;
	const r = await wireConnections({ yes: true } as never, recorder);
	expect(r.status).toBe("ok");
	expect(statSync(p).mode & 0o777).toBe(0o600);
	const keys = SETENV.map((s) => s[0]);
	expect(keys).toContain("HTTPS_PROXY");
	expect(keys).toContain("HTTP_PROXY");
	expect(keys).toContain("NO_PROXY");
	expect(keys).toContain("ANTHROPIC_BASE_URL");
	// the buckle gateway face rides ANTHROPIC_BASE_URL, never a token
	const baseUrl = SETENV.find((s) => s[0] === "ANTHROPIC_BASE_URL")?.[1];
	expect(baseUrl).toBe("http://hub.test:4101");
	expect(r.note).toContain("undo");
});

test("idempotent: the second run never overwrites and re-applies the same face", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	process.env.SUSPENDERS_DEFAULT_HUB = "TESTHUB";
	process.env.SUSPENDERS_HUB_TESTHUB_URL = "http://hub.test:4101";
	SETENV.length = 0;
	await wireConnections({ yes: true } as never, recorder);
	const before = readFileSync(p, "utf8");
	const firstFace = JSON.stringify(SETENV);
	const second = await wireConnections({ yes: true } as never, recorder);
	expect(readFileSync(p, "utf8")).toBe(before);
	expect(JSON.stringify(SETENV.slice(SETENV.length / 2))).toBe(firstFace);
	expect(second.note).toContain("never overwritten");
});

test("absent without --yes: pauses with the exact ASK, writes nothing", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	process.env.SUSPENDERS_DEFAULT_HUB = "TESTHUB";
	SETENV.length = 0;
	const r = await wireConnections({ yes: false } as never, recorder);
	expect(r.status).toBe("need_user_action");
	expect(r.note).toContain(GUI_PROXY_ASK);
	expect(existsSync(p)).toBe(false);
	expect(SETENV.length).toBe(0);
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
	const r = await wireConnections({ yes: true } as never, recorder);
	expect(r.status).toBe("failed");
	expect(readFileSync(p, "utf8")).toBe("{not json");
});

test("unresolved default hub: the face degrades, the file still lands", async () => {
	const p = tmpFile();
	process.env.SUSPENDERS_CONNECTIONS_FILE = p;
	process.env.SUSPENDERS_DEFAULT_HUB = "TESTHUB";
	const r = await wireConnections(
		{ yes: true } as never,
		recorder,
		async () => null,
	);
	expect(r.status).toBe("ok");
	expect(statSync(p).mode & 0o777).toBe(0o600);
	expect(r.note).toContain("launchctl face skipped");
});
