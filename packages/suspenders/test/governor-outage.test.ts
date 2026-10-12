// governor-outage.test.ts — W576.3 acceptance: when the registry store
// cannot open, the edit gate STILL ALLOWS the edit (owner law: gates are
// guard-rails, not boundaries) AND the degraded outcome is audited — one
// deduped structured event in outage.jsonl, outside the dead authority.
// Real subprocess, isolated HOME; `governor.db` staged as a DIRECTORY so
// openGovernorDb throws deterministically on every invocation.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-outage-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-outage-repo-"));
const REG = join(HOME, ".cache", "claude-governor");
const LEDGER = join(REG, "outage.jsonl");

mkdirSync(join(REPO, ".git"), { recursive: true });
mkdirSync(REG, { recursive: true });
// the outage: the DB path exists as a directory — sqlite cannot open it
mkdirSync(join(REG, "governor.db"), { recursive: true });

const env = { ...process.env, HOME };
const HOOKS = join(import.meta.dir, "..", "hooks");

let payloadN = 0;
function editGate(): { out: string; code: number } {
	const payload = join(HOME, `hook-payload-${payloadN++}.json`);
	writePayload(payload);
	const p = Bun.spawnSync(["bun", join(HOOKS, "gate.ts"), "governor"], {
		cwd: REPO,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString(), code: p.exitCode };
}

function writePayload(p: string): void {
	const { writeFileSync } = require("node:fs");
	writeFileSync(
		p,
		JSON.stringify({
			tool_name: "Write",
			tool_input: {
				file_path: join(REPO, "src.ts"),
				content: "export const x = 1;\n",
			},
			session_id: "outage-lane",
			transcript_path: join(HOME, "outage-lane.jsonl"),
		}),
	);
}

function dbOpenOutages(): { phase: string; reasonCode: string }[] {
	if (!existsSync(LEDGER)) return [];
	return readFileSync(LEDGER, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { phase: string; reasonCode: string })
		.filter((j) => j.phase === "db-open");
}

describe("governor edit gate under store outage", () => {
	test("fails open — the edit is allowed with a dead store", () => {
		const r = editGate();
		expect(r.out).toBe("{}");
		expect(r.code).toBe(0);
	});

	test("degraded outcome is audited outside the dead authority", () => {
		const events = dbOpenOutages();
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events[0].reasonCode).toBe("store-unavailable");
	});

	test("the dedupe window bounds a sustained outage across gate processes", () => {
		const n = dbOpenOutages().length;
		editGate();
		editGate();
		const after = dbOpenOutages().length;
		expect(after).toBe(n); // same (op, phase, class) inside 30s window
	});
});
