// test/helpers/gate-spawn.ts — W1275.3: the ONE gate.ts test-spawn recipe.
// Gate suites spawn the real hooks/gate.ts with a JSON payload through a
// temp file (Bun spawnSync drops `input`); suites keep only their event,
// cwd and env pins. Payload files ride a helper-owned mkdtemp — they carry
// the hook INPUT only; governor-leased fixture paths stay suite-owned
// (gates.test.ts keeps its cwd fixtures for exactly that reason).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dir, "..", "..", "hooks", "gate.ts");

export interface GateJson {
	hookSpecificOutput?: {
		permissionDecision?: string;
		permissionDecisionReason?: string;
		additionalContext?: string;
	};
}

export function gateSpawn(
	event: string,
	payload: unknown,
	opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): { code: number | null; json: GateJson | null } {
	const pf = join(
		mkdtempSync(join(tmpdir(), "w1275-gate-spawn-")),
		"payload.json",
	);
	writeFileSync(pf, JSON.stringify(payload));
	const r = Bun.spawnSync(["bun", GATE, event], {
		stdin: Bun.file(pf),
		stdout: "pipe",
		stderr: "pipe",
		cwd: opts.cwd,
		env: { ...process.env, ...(opts.env ?? {}) },
	});
	rmSync(join(pf, ".."), { recursive: true, force: true });
	let json: GateJson | null = null;
	try {
		json = JSON.parse(r.stdout.toString());
	} catch {}
	return { code: r.exitCode, json };
}
