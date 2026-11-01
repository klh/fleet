// test/store-port.test.ts — W92.1: the store port (govdb openStore seam).
// 1) the fact-set arg() null-sentinel regression (lesson.coord-arg-null-sentinel)
// 2) binding resolution: in-process default, "local" override, dead-URL fails
//    at open (work.ts's mirror fallback depends on that timing)
// 3) the HTTP transport: CLI verbs byte-identical across bindings,
//    transactions (work add/done id allocation) over the wire, token auth.
// Every subprocess runs against an isolated temp HOME created under the repo
// (never /tmp — the bash gate exempts /tmp paths by design) and never opens
// the live governor.db.
import { freePort } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { FACT_SCHEMA_NOTE } from "../hooks/coord/facts.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.describe("@api", () => {
	const BIN = join(import.meta.dir, "..", "hooks", "bin");
	const SERVER = join(BIN, "store-server.ts");
	const GOVDB = join(
		import.meta.dir,
		"..",
		"hooks",
		"lib",
		"govdb",
		"govdb.ts",
	);
	const home = mkdtempSync(join(tmpdir(), "suspenders-store-port-test-"));
	const repo = mkdtempSync(join(tmpdir(), "suspenders-store-port-repo-"));
	// a repo here must be a REAL git checkout — project identity resolves the
	// common git dir; an empty mkdir would walk up into this repo. One commit:
	// work done verifies the closing sha against a real object (W833), and an
	// unborn HEAD has none.
	Bun.spawnSync(["git", "init", "-q", repo]);
	Bun.spawnSync(["git", "-C", repo, "config", "user.email", "lane@w92.test"]);
	Bun.spawnSync(["git", "-C", repo, "config", "user.name", "w92 lane"]);
	writeFileSync(join(repo, "seed.txt"), "w92 store-port fixture\n");
	Bun.spawnSync(["git", "-C", repo, "add", "seed.txt"]);
	Bun.spawnSync(["git", "-C", repo, "commit", "-qm", "w92 fixture seed"]);

	const procs: ReturnType<typeof Bun.spawn>[] = [];
	test.afterAll(() => {
		for (const p of procs) p.kill();
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	// child env base: playwright sets FORCE_COLOR=1 in its workers and bun's
	// stderr coloring honors it over NO_COLOR — the ANSI wrap would make
	// byte-exact stderr assertions machine-dependent. Strip it.
	const childEnv = (): Record<string, string> => {
		const env = { ...process.env, HOME: home, NO_COLOR: "1" };
		delete env.FORCE_COLOR;
		return env as Record<string, string>;
	};
	const cli = (
		name: string,
		args: string[],
		env: Record<string, string> = {},
	): { code: number; out: string; err: string } => {
		const p = Bun.spawnSync(["bun", join(BIN, name), ...args], {
			cwd: repo,
			env: { ...childEnv(), ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			err: p.stderr.toString(),
		};
	};

	const coord = (args: string[], env: Record<string, string> = {}) =>
		cli("coord.ts", args, env);
	const work = (args: string[], env: Record<string, string> = {}) =>
		cli("work.ts", args, env);

	const runIn = (code: string, env: Record<string, string> = {}): string => {
		const p = Bun.spawnSync(["bun", "-e", code], {
			env: { ...childEnv(), ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0)
			throw new Error(`spawn failed: ${p.stderr.toString()}`);
		return p.stdout.toString();
	};

	const startServer = async (
		port: number,
		env: Record<string, string> = {},
	): Promise<string> => {
		const p = Bun.spawn(["bun", SERVER, "--port", String(port)], {
			env: { ...childEnv(), ...env },
			stdout: "ignore",
			stderr: "ignore",
		});
		procs.push(p);
		const url = `http://127.0.0.1:${port}`;
		for (let i = 0; i < 50; i++) {
			try {
				const r = await fetch(`${url}/health`);
				if (r.ok) return url;
			} catch {}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error("store server did not come up");
	};

	// ── the regression the lane brief calls out (hotfix 62732ab) ────────────────
	// W836: every fact set/get print appends the audit-trust schema note —
	// assertions pin the exact two-line shape.
	test.describe("fact set — arg() null sentinel (lesson.coord-arg-null-sentinel)", () => {
		test("positional value lands", () => {
			const r = coord(["fact", "set", "w921.pos", "positional-value"]);
			expect(r.code).toBe(0);
			expect(r.out).toBe(
				`fact w921.pos = positional-value\n${FACT_SCHEMA_NOTE}\n`,
			);
		});
		test("--text value lands verbatim", () => {
			const r = coord([
				"fact",
				"set",
				"w921.text",
				"--text",
				"multi word value",
			]);
			expect(r.code).toBe(0);
			expect(r.out).toBe(
				`fact w921.text = multi word value\n${FACT_SCHEMA_NOTE}\n`,
			);
		});
		test("bare --text dies with usage (the hotfixed path)", () => {
			const r = coord(["fact", "set", "w921.bad", "--text"]);
			expect(r.code).toBe(2);
			// W1226: usage now lists the provenance flags too
			expect(r.err).toBe(
				"coord: usage: fact set <key> <value> | fact set <key> --text <text> [--source s] [--if-version n] [--trigger t] [--explanation e] [--procedure p] [--verification v] [--source-commit sha] [--applicability a]\n",
			);
		});
		test("get round-trips both shapes", () => {
			expect(coord(["fact", "get", "w921.pos"]).out).toBe(
				`positional-value (v1)\n${FACT_SCHEMA_NOTE}\n`,
			);
			expect(coord(["fact", "get", "w921.text"]).out).toBe(
				`multi word value (v1)\n${FACT_SCHEMA_NOTE}\n`,
			);
		});
	});

	test.describe("openStore() binding resolution", () => {
		test("default binding is in-process and local", () => {
			const out = runIn(
				`const { openStore } = await import(${JSON.stringify(GOVDB)});
	const s = openStore();
	console.log(JSON.stringify({ local: s.local, one: s.query("SELECT 1 AS one").get() }));`,
			);
			expect(JSON.parse(out)).toEqual({ local: true, one: { one: 1 } });
		});
		test("GOVERNOR_STORE_URL=local forces in-process", () => {
			const out = runIn(
				`const { openStore } = await import(${JSON.stringify(GOVDB)});
	const s = openStore();
	console.log(JSON.stringify({ local: s.local }));`,
				{ GOVERNOR_STORE_URL: "local" },
			);
			expect(JSON.parse(out)).toEqual({ local: true });
		});
		test("dead URL fails AT OPEN (transport probe, not first query)", () => {
			const r = coord(["fact", "get", "x"], {
				GOVERNOR_STORE_URL: "http://127.0.0.1:1",
			});
			expect(r.code).not.toBe(0);
			expect(r.err).toContain("unreachable");
		});
	});

	test.describe("HTTP transport (store-server.ts)", () => {
		let url = "";
		test.beforeAll(async () => {
			url = await startServer(await freePort());
		});
		test("work verbs with transactions ride the wire", () => {
			expect(
				work(["add", "http item", "--by", "lane-h"], hdr(url)).out,
			).toContain("✓ W1 READY");
			const takeOut = work(["take", "W1", "--as", "lane-h"], hdr(url)).out;
			expect(takeOut).toContain("✓ W1 claimed by lane-h");
			const tok = /claim token: ([0-9a-f]{48})/.exec(takeOut)?.[1];
			// W833: done demands a verifiable commit sha (the fixture repo's
			// HEAD) + a 40-char summary paragraph; the close line is the prefix
			const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
				cwd: repo,
				stdout: "pipe",
			})
				.stdout.toString()
				.trim()
				.slice(0, 8);
			const doneOut = work(
				[
					"done",
					"W1",
					"--sha",
					sha,
					...(tok ? ["--token", tok] : []),
					"--summary",
					"wire-close smoke: the HTTP transaction allocates and completes one item",
				],
				hdr(url),
			).out;
			expect(doneOut).toContain(`✓ W1 DONE @${sha}`);
			expect(work(["list"], hdr(url)).out).toBe("(none)\n");
		});
		test("fact + event verbs byte-identical over HTTP", () => {
			expect(coord(["fact", "set", "k.h", "hello"], hdr(url)).out).toBe(
				`fact k.h = hello\n${FACT_SCHEMA_NOTE}\n`,
			);
			expect(coord(["fact", "get", "k.h"], hdr(url)).out).toBe(
				`hello (v1)\n${FACT_SCHEMA_NOTE}\n`,
			);
			expect(coord(["fact", "list"], hdr(url)).out).toContain("k.h = hello");
			expect(
				coord(["emit", "test.x", "--as", "lane-h"], hdr(url)).out,
			).toContain("event queued #");
			expect(coord(["inbox", "--as", "nobody"], hdr(url)).out).toBe(
				"(inbox empty)\n",
			);
		});
		test("token auth: open loopback endpoint takes the shared token", async () => {
			const port = await freePort();
			const turl = await startServer(port, { GOVERNOR_STORE_TOKEN: "t0ken" });
			expect(
				coord(["fact", "get", "k.h"], {
					GOVERNOR_STORE_URL: turl,
					GOVERNOR_STORE_TOKEN: "t0ken",
				}).out,
			).toBe(`hello (v1)\n${FACT_SCHEMA_NOTE}\n`);
			const refused = coord(["fact", "get", "k.h"], {
				GOVERNOR_STORE_URL: turl,
			});
			expect(refused.code).not.toBe(0);
			// W662 — a real HTTP status surfaces, not the old "unreachable" mask
			expect(refused.err).toContain("HTTP 403");
		});

		// W662 — server-side 500s used to masquerade as "unreachable" (curl -f
		// flattens any >= 400 to exit 22). Async spawn: an in-process stub server
		// cannot answer a spawnSync child (W362).
		test("server errors surface their HTTP status, not 'unreachable'", async () => {
			const s = Bun.serve({
				port: 0,
				fetch: () => new Response("boom", { status: 500 }),
			});
			const p = Bun.spawn(
				["bun", join(BIN, "coord.ts"), "fact", "get", "k.h"],
				{
					cwd: repo,
					env: {
						...process.env,
						HOME: home,
						NO_COLOR: "1",
						GOVERNOR_STORE_URL: `http://127.0.0.1:${s.port}`,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			await p.exited;
			const err = await new Response(p.stderr).text();
			s.stop(true);
			expect(p.exitCode).not.toBe(0);
			expect(err).toContain("HTTP 500");
			expect(err).not.toContain("unreachable");
		});
	});

	function hdr(url: string): Record<string, string> {
		return { GOVERNOR_STORE_URL: url };
	}
});
