// test/advisory-cooldown.test.ts — W645 content-keyed advisory cooldown
// (claudecode research §1.6). Unit leg pins keying/TTL/cap/disable rules
// with state isolated in a temp TMPDIR; the gate leg spawns the REAL
// gate.ts post-files with a fmt-always-rewrites qlty stub and pins that an
// identical advisory on the same file is delivered once, a different file
// delivers again, and TTL=0 disables.
import { expect, test } from "@playwright/test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ADVISORY_COOLDOWN_CAP,
	advisorySeen,
	cooldownMs,
	oncePerSession,
} from "../hooks/lib/advisory-cooldown.ts";

const TMP = mkdtempSync(join(tmpdir(), "suspenders-advcd-"));
const REAL_TMPDIR = process.env.TMPDIR;
test.afterAll(() => {
	process.env.TMPDIR = REAL_TMPDIR; // shared bun process — other suites follow
	rmSync(TMP, { recursive: true, force: true });
});
// session-state IO resolves TMPDIR at call time — pin it to the fixture dir
// so unit-leg cooldown state never touches the real per-session state.
process.env.TMPDIR = TMP;

test.describe("cooldown lib", () => {
	test("same message+session inside TTL → seen; different session/message not", () => {
		const a = advisorySeen("cd-s1", "advise: drink water");
		const b = advisorySeen("cd-s1", "advise: drink water");
		expect(a).toBe(false);
		expect(b).toBe(true);
		expect(advisorySeen("cd-s2", "advise: drink water")).toBe(false);
		expect(advisorySeen("cd-s1", "advise: stretch")).toBe(false);
	});

	test("TTL expiry re-delivers; 0 disables entirely", async () => {
		process.env.SUSPENDERS_ADVISORY_COOLDOWN_MS = "30";
		expect(advisorySeen("cd-ttl", "short ttl")).toBe(false);
		expect(advisorySeen("cd-ttl", "short ttl")).toBe(true);
		await Bun.sleep(40);
		expect(advisorySeen("cd-ttl", "short ttl")).toBe(false);
		process.env.SUSPENDERS_ADVISORY_COOLDOWN_MS = "0";
		expect(advisorySeen("cd-off", "off")).toBe(false);
		expect(advisorySeen("cd-off", "off")).toBe(false);
		delete process.env.SUSPENDERS_ADVISORY_COOLDOWN_MS;
	});

	test("cooldownMs parsing matches readCapBytes contract", () => {
		expect(cooldownMs(undefined)).toBe(5 * 60_000);
		expect(cooldownMs("")).toBe(5 * 60_000);
		expect(cooldownMs("0")).toBe(0);
		expect(cooldownMs("100")).toBe(100);
		expect(cooldownMs("-5")).toBe(5 * 60_000);
		expect(cooldownMs("junk")).toBe(5 * 60_000);
	});

	test("cap bounds the state file, newest kept", async () => {
		for (let i = 0; i < ADVISORY_COOLDOWN_CAP + 10; i++)
			advisorySeen("cd-cap", `message ${i}`);
		const stateFile = join(TMP, "claude-advcd-cd-cap.json");
		const entries = Object.keys(
			JSON.parse(await Bun.file(stateFile).text()) as Record<string, number>,
		);
		expect(entries.length).toBe(ADVISORY_COOLDOWN_CAP);
	});

	test("oncePerSession without sid always delivers", () => {
		expect(oncePerSession(undefined, "no sid")).toBe("no sid");
		expect(oncePerSession(undefined, "no sid")).toBe("no sid");
	});
});

test.describe("gate leg — post-files advisory dedupe (real gate.ts)", () => {
	const root = join(TMP, "gate");
	const bin = join(root, "bin");
	// qlty stub: fmt ALWAYS rewrites (append \n) so every save yields the
	// same "auto-fixed" advisory for the same path; check exits clean.
	const stub = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = args.at(-1);
if (args[0] === "fmt") fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\\n");
process.exit(0);
`;

	test.beforeAll(() => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "qlty"), stub);
		chmodSync(join(bin, "qlty"), 0o755);
	});

	const fixtureFile = (name: string): string => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		Bun.spawnSync(["git", "init", "-q", dir]);
		const f = join(dir, "source.ts");
		writeFileSync(f, "export const x=1\n");
		return f;
	};

	function gate(f: string, sid: string): { out: string } {
		const input = join(TMP, `input-${sid}-${f.replace(/\W+/g, "-")}.json`);
		writeFileSync(
			input,
			JSON.stringify({
				cwd: join(f, ".."),
				tool_name: "Write",
				session_id: sid,
				tool_input: { file_path: f },
			}),
		);
		const r = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "..", "hooks", "gate.ts"),
				"post-files",
			],
			{
				stdin: Bun.file(input),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: root,
					TMPDIR: TMP,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					SUSPENDERS_GATE_WRITES: join(TMP, "gate-writes.jsonl"),
				},
			},
		);
		return { out: r.stdout.toString() };
	}

	test("identical advisory delivered once, other file delivers again", () => {
		const f1 = fixtureFile("repo1");
		const f2 = fixtureFile("repo2");
		expect(gate(f1, "cd-gate").out).toContain("qlty-fmt: auto-fixed");
		expect(gate(f1, "cd-gate").out).not.toContain("qlty-fmt: auto-fixed");
		expect(gate(f2, "cd-gate").out).toContain("qlty-fmt: auto-fixed");
	});
});
