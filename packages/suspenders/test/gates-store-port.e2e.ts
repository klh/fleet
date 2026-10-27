// test/gates-store-port.test.ts — W92.4: the gates ride the store port.
// governor + bash gates run as real subprocesses bound to a LIVE
// store-server (GOVERNOR_STORE_URL); leases must cross the wire both ways —
// a lease taken by session A through the port blocks session B over the
// same port, and the lock row lands in the SERVER's governor.db. Every
// child gets an isolated temp HOME (never the live governor.db); the server
// owns that HOME's db file, the children never open it locally.
import { expect, test } from "./pw";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = join(import.meta.dir, "..", "hooks");
const GOVDB = join(HOOKS, "lib", "govdb", "govdb.ts");
const SERVER = join(HOOKS, "bin", "store-server.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-gates-port-"));
const repo = mkdtempSync(join(tmpdir(), "suspenders-gates-port-repo-"));
// a repo here must be a REAL git checkout — project identity resolves the
// common git dir; an empty mkdir would walk up into this repo
Bun.spawnSync(["git", "init", "-q", repo]);
mkdirSync(join(home, ".cache", "claude-governor"), { recursive: true });

const procs: ReturnType<typeof Bun.spawn>[] = [];
test.afterAll(() => {
	for (const p of procs) p.kill();
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};

let url = "";
const boot = async (): Promise<void> => {
	url = `http://127.0.0.1:${await freePort()}`;
	const p = Bun.spawn(["bun", SERVER, "--port", url.split(":").pop() ?? ""], {
		env: { ...process.env, HOME: home, NO_COLOR: "1" },
		stdout: "ignore",
		stderr: "ignore",
	});
	procs.push(p);
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`${url}/health`);
			if (r.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("store server did not come up");
};

const childEnv = (): Record<string, string> =>
	({
		...process.env,
		HOME: home,
		NO_COLOR: "1",
		GOVERNOR_STORE_URL: url,
	}) as Record<string, string>;

interface GateVerdict {
	deny: string | null;
	out: string;
	code: number | null;
}

/** Run `gate.ts <event>` as a real subprocess; returns the deny reason when
 * the verdict is deny, null on allow. */
const gate = (
	event: string,
	toolName: string,
	toolInput: Record<string, unknown>,
	sid: string,
): GateVerdict => {
	const payload = join(home, `payload-${Math.random().toString(36).slice(2)}`);
	writeFileSync(
		payload,
		JSON.stringify({
			tool_name: toolName,
			tool_input: toolInput,
			session_id: sid,
			transcript_path: join(home, `${sid}.jsonl`),
		}),
	);
	return finishGate(event, payload);
};

const finishGate = (event: string, payload: string): GateVerdict => {
	const p = Bun.spawnSync(["bun", join(HOOKS, "gate.ts"), event], {
		cwd: repo,
		env: childEnv(),
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = p.stdout.toString();
	let deny: string | null = null;
	try {
		const parsed = JSON.parse(out || "{}") as {
			hookSpecificOutput?: {
				permissionDecision?: string;
				permissionDecisionReason?: string;
			};
		};
		if (parsed.hookSpecificOutput?.permissionDecision === "deny")
			deny = parsed.hookSpecificOutput.permissionDecisionReason ?? "";
	} catch {}
	return { deny, out, code: p.exitCode };
};

/** Query the SERVER-side store (the way a second lane would bind). */
const serverQuery = (sql: string, ...params: unknown[]): unknown => {
	const code = `const { openStore } = await import(${JSON.stringify(GOVDB)});
const s = openStore();
console.log(JSON.stringify(s.query(${JSON.stringify(sql)}).all(...${JSON.stringify(params)})));`;
	const p = Bun.spawnSync(["bun", "-e", code], {
		env: childEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	return JSON.parse(p.stdout.toString());
};

test.describe("gates ride the store port (W92.4)", () => {
	test.beforeAll(boot);
	const F = join(repo, "src.ts");

	test("boot produces a live server", () => {
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});

	test("edit lease crosses the wire: A acquires, B is denied", () => {
		const a = gate(
			"governor",
			"Write",
			{ file_path: F, content: "x\n" },
			"lane-a",
		);
		expect(a.deny).toBeNull();
		// re-read after fmt; asserting the full allow verdict surfaces the
		// subprocess's real stdout when the lease never lands remotely
		expect(a.code).toBe(0);
		expect(a.out).toBe("{}");
		const rows = serverQuery(
			"SELECT sid FROM locks WHERE path LIKE ?",
			`%${F.split("/").pop()}`,
		) as { sid: string }[];
		expect(rows.some((r) => r.sid === "lane-a")).toBe(true);
		const b = gate(
			"governor",
			"Write",
			{ file_path: F, content: "y\n" },
			"lane-b",
		);
		expect(b.deny).toContain("leased to another agent");
	});

	test("bash gate honors a remote lease", () => {
		const b = gate("pre-bash", "Bash", { command: `echo x > ${F}` }, "lane-c");
		expect(b.deny).toContain("blocked — leased to another agent");
	});

	test("in-process default binding still allows a fresh edit", () => {
		const code = [
			`const m = await import(${JSON.stringify(join(HOOKS, "gates", "governor.ts"))});`,
			`const h = await import(${JSON.stringify(join(HOOKS, "lib", "hookio.ts"))});`,
			`m.governorGate({`,
			`	tool_name: "Write",`,
			`	tool_input: { file_path: ${JSON.stringify(join(repo, "other.ts"))}, content: "x\\n" },`,
			`	session_id: "lane-local",`,
			`	transcript_path: ${JSON.stringify(join(home, "lane-local.jsonl"))},`,
			`});`,
			`h.allow();`,
		].join("\n");
		const p = Bun.spawnSync(["bun", "-e", code], {
			cwd: repo,
			env: { ...process.env, HOME: home, NO_COLOR: "1" }, // NO GOVERNOR_STORE_URL
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).toBe(0);
		expect(p.stdout.toString()).toBe("{}");
	});
});
