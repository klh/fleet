// test/hook-adapter.test.ts — W73: the codex hook adapter. Covers the two
// translations (payload in / decision out), the identity invariant (fleet
// sid on every governor row), the emitter's merge-not-clobber contract, and
// one integration tooth: a governor lease deny surfacing as codex decision
// JSON through the real gate.ts codex entrypoint.
import { describe, test, expect, afterAll } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	mkdirSync,
	symlinkSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	buildDecision,
	resolveCodexSid,
	normalizeCodex,
} from "../hooks/dialects/codex/lib.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w73-"));
const REPO = realpathSync(mkdtempSync(join(tmpdir(), "suspenders-w73-repo-")));
mkdirSync(join(REPO, ".fleet"), { recursive: true });
// scrub lane identity — session-start's canonical-v1 guard refuses fixture
// sids when a dispatched lane's own SUSPENDERS_* env leaks in (W383)
const env = (): Record<string, string> => {
	const e = { ...(process.env as Record<string, string>), HOME };
	delete e.SUSPENDERS_SID;
	delete e.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
	e.KLH_SESSION_ROLE = "lane"; // W834: tests exercise gate logic, not role
	return e;
};
const GATE = join(import.meta.dir, "..", "hooks", "gate.ts");
const WIRE = join(
	import.meta.dir,
	"..",
	"hooks",
	"dialects",
	"codex",
	"wire.ts",
);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
	rmSync(GHOME, { recursive: true, force: true });
});

const run = (
	args: string[],
	input: unknown,
	extra: Record<string, string> = {},
) => {
	const pf = join(
		REPO,
		`payload-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
	);
	writeFileSync(pf, typeof input === "string" ? input : JSON.stringify(input));
	const p = Bun.spawnSync(["bun", ...args], {
		cwd: REPO,
		env: { ...env(), ...extra },
		stdin: Bun.file(pf),
		stdout: "pipe",
		stderr: "pipe",
	});
	rmSync(pf, { force: true });
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
};

const gate = (
	args: string[],
	input: unknown,
	extra: Record<string, string> = {},
) => run([GATE, ...args], input, extra);

// ---- payload normalization (codex → HookInput) ----

describe("normalizeCodex", () => {
	const norm = (raw: Record<string, unknown>, tool: string) =>
		normalizeCodex(raw, tool, "PreToolUse");

	test("shell tool rides command-level as Bash", () => {
		const n = norm(
			{ tool_input: { command: "rg -n foo ." }, cwd: REPO },
			"shell",
		);
		expect(n.gate).toBe("pre-bash");
		expect(n.hook.tool_name).toBe("Bash");
		expect((n.hook.tool_input as Record<string, unknown>).command).toBe(
			"rg -n foo .",
		);
	});

	test("apply_patch lifts the first file with old/new strings", () => {
		const n = norm(
			{
				tool_input: {
					command:
						"apply_patch <<EOF\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
				},
				cwd: REPO,
			},
			"apply_patch",
		);
		expect(n.gate).toBe("pre-files");
		expect(n.hook.tool_name).toBe("Edit");
		expect((n.hook.tool_input as Record<string, unknown>).file_path).toBe(
			"src/a.ts",
		);
		expect((n.hook.tool_input as Record<string, unknown>).old_string).toBe(
			"old",
		);
		expect((n.hook.tool_input as Record<string, unknown>).new_string).toBe(
			"new",
		);
	});

	test("unknown tool with no patch body falls back to command-style", () => {
		const n = norm(
			{ tool_input: { command: "echo hi" }, cwd: REPO },
			"mystery_tool",
		);
		expect(n.gate).toBe("pre-bash");
	});

	test("patch body under unknown tool name still routes pre-files", () => {
		const n = norm(
			{
				tool_input: { command: "*** Begin Patch\n*** Add File: b.txt\n+hi\n" },
				cwd: REPO,
			},
			"mystery_tool",
		);
		expect(n.gate).toBe("pre-files");
	});
});

// ---- output translation (the teeth) ----

describe("buildDecision translation table", () => {
	test("allow is empty control JSON", () => {
		expect(buildDecision("allow", "PreToolUse", "")).toEqual({
			stdout: "{}",
			exit: 0,
		});
	});

	test("deny requires reason, targets the codex event", () => {
		const d = buildDecision("deny", "PostToolUse", "lease held by autow5");
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			hookSpecificOutput: Record<string, string>;
		};
		expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
			"autow5",
		);
		expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
		expect(d.exit).toBe(0);
	});

	test("ask degrades to deny (never silently allow)", () => {
		const d = buildDecision(
			"ask",
			"PreToolUse",
			"governor: request access via coord",
		);
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			hookSpecificOutput: Record<string, string>;
		};
		expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
			"request access",
		);
	});

	test("ask without reason still yields non-empty reason", () => {
		const d = buildDecision("ask", "PreToolUse", "");
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			hookSpecificOutput: Record<string, string>;
		};
		expect(
			parsed.hookSpecificOutput.permissionDecisionReason.length,
		).toBeGreaterThan(0);
	});

	test("context/nudge emit additionalContext", () => {
		const d = buildDecision("context", "SessionStart", "SESSION x  OWNED 1");
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			hookSpecificOutput: Record<string, string>;
		};
		expect(parsed.hookSpecificOutput.additionalContext).toContain("OWNED 1");
		expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
	});

	test("feedback exits 2 with stderr (harness-cloned semantics)", () => {
		const d = buildDecision(
			"feedback",
			"Stop",
			"STOP-GATE: post-files errors remain",
		);
		expect(d.exit).toBe(2);
		expect(d.stderr).toContain("STOP-GATE");
	});
});

// ---- identity resolution (the correctness invariant) ----

describe("resolveCodexSid", () => {
	test("env wins", () => {
		process.env.SUSPENDERS_SID = "autowenv";
		try {
			expect(resolveCodexSid(REPO)).toEqual({ sid: "autowenv", source: "env" });
		} finally {
			delete process.env.SUSPENDERS_SID;
		}
	});

	test("lanes.json ppid-walk resolves the fleet sid", () => {
		writeFileSync(
			join(REPO, ".fleet", "lanes.json"),
			JSON.stringify([
				{
					sid: "autowpid",
					item: "W999",
					pid: process.pid,
					branch: "b",
					worktree: REPO,
				},
			]),
		);
		try {
			const r = resolveCodexSid(REPO);
			expect(r.source).toBe("lanes");
			expect(r.sid).toBe("autowpid");
		} finally {
			rmSync(join(REPO, ".fleet", "lanes.json"));
		}
	});

	test("unresolved stays unresolved (caller fail-opens + journals)", () => {
		const r = resolveCodexSid("/tmp/definitely-not-a-fleet-root-8f3k2");
		expect(r.source).toBe("unresolved");
		expect(r.sid).toBe("");
	});
});

// ---- wiring emitter (merge-not-clobber) ----

describe("gate-wire-codex emitter", () => {
	const WIREPATH = join(HOME, "hooks.json");

	test("merges five events, preserves user entries, idempotent", () => {
		writeFileSync(
			WIREPATH,
			JSON.stringify({
				model: "gpt-5",
				hooks: {
					PreToolUse: [
						{ hooks: [{ type: "command", command: "user-own-tool" }] },
					],
				},
			}),
		);
		const r1 = run([WIRE], "", { SUSPENDERS_CODEX_HOOKS: WIREPATH });
		expect(r1.code).toBe(0);
		const doc1 = JSON.parse(readFileSync(WIREPATH, "utf8")) as {
			model?: string;
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};
		expect(doc1.model).toBe("gpt-5");
		expect(doc1.hooks.PreToolUse).toHaveLength(2);
		expect(doc1.hooks.PreToolUse[0].hooks[0].command).toBe("user-own-tool");
		expect(Object.keys(doc1.hooks)).toContain("SessionEnd");

		const r2 = run([WIRE], "", { SUSPENDERS_CODEX_HOOKS: WIREPATH });
		expect(r2.out).toContain("already wired");
		const doc2 = JSON.parse(readFileSync(WIREPATH, "utf8")) as typeof doc1;
		expect(doc2.hooks.PreToolUse).toHaveLength(2); // no duplicate
	});

	test("--check exits 0 when wired, 1 when not", () => {
		const clean = join(HOME, "clean.json");
		const wired = run([WIRE, "--check"], "", {
			SUSPENDERS_CODEX_HOOKS: WIREPATH,
		});
		expect(wired.code).toBe(0);
		const unwired = run([WIRE, "--check"], "", {
			SUSPENDERS_CODEX_HOOKS: clean,
		});
		expect(unwired.code).toBe(1);
	});
});

// ---- generation stability (W2961): two fixture generations, scratch HOME ----

const GHOME = mkdtempSync(join(tmpdir(), "suspenders-w2961-"));
const GFILE = join(GHOME, "hooks.json");
const genDir = (name: string): string => {
	const d = join(GHOME, name, ".harness", "packages", "suspenders", "hooks");
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, "gate.ts"), "// fixture gate\n");
	return join(GHOME, name);
};
const GEN_A = genDir("gen-a");
const GEN_B = genDir("gen-b");
mkdirSync(join(GHOME, ".claude", "hooks"), { recursive: true });
const LINK = join(GHOME, ".claude", "hooks", "suspenders");
symlinkSync(GEN_A, LINK);
const wire = (
	args: string[] = [],
	file: string = GFILE,
): { out: string; err: string; code: number } =>
	run([WIRE, ...args], "", { SUSPENDERS_CODEX_HOOKS: file, HOME: GHOME });

describe("gate-wire-codex generation stability (W2961)", () => {
	const doc = (): GDoc => JSON.parse(readFileSync(GFILE, "utf8")) as GDoc;
	const oldPin = (mode: string): string =>
		`${process.execPath} ${GHOME}/.claude/hooks/suspenders.generation-old/.harness/packages/suspenders/hooks/dialects/codex/../../gate.ts codex ${mode}`;

	test("stale generation pin upgrades to the stable symlink in place", () => {
		writeFileSync(
			GFILE,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ hooks: [{ type: "command", command: "user-own-tool" }] },
						{ hooks: [{ type: "command", command: oldPin("pre-tool") }] },
					],
				},
			}),
		);
		const r = wire();
		expect(r.code).toBe(0);
		const pre = doc().hooks.PreToolUse;
		expect(pre).toHaveLength(2); // user entry + ONE managed entry
		expect(pre[0].hooks[0].command).toBe("user-own-tool");
		const cmd = pre[1].hooks[0].command;
		expect(cmd).toContain(
			`${GHOME}/.claude/hooks/suspenders/.harness/packages/suspenders/hooks/gate.ts`,
		);
		expect(cmd).not.toContain("suspenders.generation-");
	});

	test("intentional foreign pin preserved verbatim, stable entry alongside", () => {
		const foreign = `${process.execPath} /tmp/w2961-lane-harness/gate.ts codex pre-tool`;
		writeFileSync(
			GFILE,
			JSON.stringify({
				hooks: {
					PreToolUse: [{ hooks: [{ type: "command", command: foreign }] }],
				},
			}),
		);
		const r = wire();
		expect(r.code).toBe(0);
		const pre = doc().hooks.PreToolUse;
		expect(pre).toHaveLength(2);
		expect(pre[0].hooks[0].command).toBe(foreign);
		expect(pre[1].hooks[0].command).toContain(
			`${GHOME}/.claude/hooks/suspenders/.harness`,
		);
	});

	test("--check: stale pin exits 1 with the stale note, rewire exits 0", () => {
		writeFileSync(
			GFILE,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ hooks: [{ type: "command", command: oldPin("session") }] },
					],
				},
			}),
		);
		const stale = wire(["--check"]);
		expect(stale.code).toBe(1);
		expect(stale.out).toContain("stale generation pin");
		expect(wire().out).toContain("wired 5 codex hook events");
		const wired = wire(["--check"]);
		expect(wired.code).toBe(0);
	});

	test("--check: foreign-only pin reports not wired (install owes its entries)", () => {
		writeFileSync(
			GFILE,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: `${process.execPath} /tmp/w2961-pin/gate.ts codex session`,
								},
							],
						},
					],
				},
			}),
		);
		const foreign = wire(["--check"]);
		expect(foreign.code).toBe(1);
		expect(foreign.out).toContain("not wired");
	});

	test("sibling foreign harness under the install root is never touched", () => {
		const sibling = `${process.execPath} ${GHOME}/.claude/hooks/my-private-harness/gate.ts codex pre-tool`;
		writeFileSync(
			GFILE,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ hooks: [{ type: "command", command: "user-own-tool" }] },
						{ hooks: [{ type: "command", command: sibling }] },
					],
				},
			}),
		);
		const r = wire();
		expect(r.code).toBe(0);
		const pre = doc().hooks.PreToolUse;
		expect(pre).toHaveLength(3); // user + sibling foreign + our stable
		expect(pre[1].hooks[0].command).toBe(sibling); // preserved verbatim
		expect(pre[2].hooks[0].command).toContain(
			`${GHOME}/.claude/hooks/suspenders/.harness`,
		);
	});

	test("--check: mixed stable+stale on all events reports stale, disk untouched", () => {
		const mk = (
			mode: string,
			gen: boolean,
		): {
			hooks: Array<{ type: string; command: string }>;
		} => ({
			hooks: [
				{
					type: "command",
					command: gen
						? `${process.execPath} ${GHOME}/.claude/hooks/suspenders.generation-old/.harness/packages/suspenders/hooks/dialects/codex/../../gate.ts codex ${mode}`
						: `${process.execPath} ${GHOME}/.claude/hooks/suspenders/.harness/packages/suspenders/hooks/gate.ts codex ${mode}`,
				},
			],
		});
		const events = [
			"PreToolUse",
			"PostToolUse",
			"SessionStart",
			"Stop",
			"SessionEnd",
		];
		writeFileSync(
			GFILE,
			JSON.stringify({
				hooks: Object.fromEntries(
					events.map((e) => [e, [mk(e, false), mk(e, true)]]),
				),
			}),
		);
		const before = readFileSync(GFILE, "utf8");
		const r = wire(["--check"]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("stale generation pin"); // wiredNow alone must not green-light a mixed file
		expect(readFileSync(GFILE, "utf8")).toBe(before); // --check never writes
	});

	test("symlink flip = the rollback surface; wiring is generation-stable", () => {
		writeFileSync(GFILE, "{}");
		expect(wire().out).toContain("wired 5 codex hook events");
		const before = doc().hooks.PreToolUse.at(-1).hooks[0].command;
		expect(before).toContain(`${GHOME}/.claude/hooks/suspenders/.harness`);
		// two fixture generations: flip the symlink gen-a → gen-b and re-wire
		rmSync(LINK);
		symlinkSync(GEN_B, LINK);
		expect(wire().out).toContain("already wired"); // no re-pin on flip
		const cmd = doc().hooks.PreToolUse.at(-1).hooks[0].command;
		expect(cmd).toBe(before); // byte-identical across generations
		const gatePath = cmd.split(" ").find((p) => p.includes("gate.ts"));
		expect(existsSync(gatePath ?? "")).toBe(true); // resolves through gen-b
	});

	test("current runner settings accepted by the active-generation gate", () => {
		const settingsFile = join(GHOME, "settings.json");
		writeFileSync(
			settingsFile,
			JSON.stringify({
				runner: {
					control_url: "http://127.0.0.1:7810",
					identity_url: "http://127.0.0.1:4111",
				},
			}),
		);
		const r = gate(
			["codex", "session"],
			{ cwd: REPO },
			{
				KLH_SETTINGS: settingsFile,
			},
		);
		expect(r.code).toBe(0);
		// accepted, not silently fallen back: hook-mode posture never surfaces
		// the last-known-good degradation for a schema-valid settings file
		expect(r.err).not.toContain("last-known-good");
		expect(r.err).not.toContain("is invalid");
	});
});

// ---- integration: the teeth through the real entrypoint ----

describe("gate.ts codex integration", () => {
	test("post-tool delivers pushed consults without skipping file validation", () => {
		const sid = `w937-${Math.random().toString(36).slice(2)}`;
		// W1107.1.1.2.2: the CI law scan (tests/law-guards.test.ts) regexes raw
		// tracked text, so this fixture — which exists to prove the gate BLOCKS
		// the banned DOM write — assembles the payload at runtime. The string
		// reaching the gate is byte-identical; the scan sees no literal.
		const domWritePatch = `*** Begin Patch\n*** Add File: bad.ts\n+${["document", "write('unsafe')"].join(".")}\n*** End Patch`;
		const logDir = join(HOME, ".claude-insights");
		mkdirSync(logDir, { recursive: true });
		appendFileSync(
			join(logDir, `coord-subscribe-${sid}.log`),
			"#1 consult C91 from Fleet: coordinate shared work\n",
		);
		const blocked = gate(
			["codex", "post-tool"],
			{
				tool_name: "apply_patch",
				tool_input: {
					command: domWritePatch,
				},
				cwd: REPO,
				session_id: sid,
			},
			{ SUSPENDERS_PUSH_TAIL: "" },
		);
		expect(blocked.code).toBe(2);
		expect(blocked.err).toContain("UI LAW");
		const delivered = gate(
			["codex", "post-tool"],
			{
				tool_name: "shell",
				tool_input: { command: "rg Fleet ." },
				cwd: REPO,
				session_id: sid,
			},
			{ SUSPENDERS_PUSH_TAIL: "" },
		);
		expect(delivered.code).toBe(0);
		expect(delivered.out).toContain("consult C91 from Fleet");
		expect(
			gate(["codex", "post-tool"], {
				tool_name: "shell",
				cwd: REPO,
				session_id: sid,
			}).out,
		).toBe("{}");
	});

	test("pre-tool shell allow rides through", () => {
		const r = gate(["codex", "pre-tool"], {
			tool_name: "shell",
			tool_input: { command: "ls" },
			cwd: REPO,
		});
		const parsed = JSON.parse(r.out) as {
			hookSpecificOutput?: { permissionDecision?: string };
		};
		expect(parsed.hookSpecificOutput?.permissionDecision ?? "allow").toBe(
			"allow",
		); // nudges ride additionalContext
		expect(r.code).toBe(0);
	});

	test("governor lease deny surfaces as codex deny JSON", () => {
		// materialize the registry first: a session gate creates dir + DB via
		// the real govdb migration, so the direct Database open below succeeds
		gate(["codex", "session"], { cwd: REPO }, { SUSPENDERS_SID: "autow-seed" });
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.query(
			"INSERT OR REPLACE INTO locks (path, sid, tool, ts, hash) VALUES (?, ?, ?, ?, ?)",
		).run(join(REPO, "leased.ts"), "autow-other", "Write", Date.now(), "x");
		db.close();
		const r = gate(
			["codex", "pre-tool"],
			{
				tool_name: "apply_patch",
				tool_input: {
					command: "*** Begin Patch\n*** Update File: leased.ts\n@@\n-a\n+b\n",
				},
				cwd: REPO,
			},
			{ SUSPENDERS_SID: "autow-mine" },
		);
		const parsed = JSON.parse(r.out) as {
			hookSpecificOutput: {
				permissionDecision: string;
				permissionDecisionReason: string;
			};
		};
		expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
			"leased to another agent",
		);
	});

	test("codex session registers the fleet sid in governor.db", () => {
		gate(["codex", "session"], { cwd: REPO }, { SUSPENDERS_SID: "autow-sess" });
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		const row = db
			.query("SELECT sid, state FROM sessions WHERE sid = 'autow-sess'")
			.get() as {
			sid: string;
			state: string;
		} | null;
		db.close();
		expect(row?.sid).toBe("autow-sess");
	});
});
