// test/install-contract.test.ts — W490.1: the installer's machine-readable
// contract. Every JSON outcome parses and carries contractVersion +
// agent_next_steps + every documented flag; --dry-run mutates nothing
// (temp-PREFIX snapshot before/after); every documented step name is accepted
// via --step; the contract flags and meow's flags never drift.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_CONTRACT } from "../scripts/install-contract.ts";
import { meowFlags } from "../scripts/install-cli.ts";

const BIN = `${import.meta.dir}/../scripts/install.ts`;

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function run(
	args: string[],
	env?: Record<string, string>,
): Promise<RunResult> {
	const proc = Bun.spawn(["bun", BIN, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout, stderr };
}

function snapshot(dir: string): string {
	const walk = (p: string, prefix: string): string[] => {
		const entries = readdirSync(p, { withFileTypes: true });
		return entries.flatMap((e) => {
			const full = join(p, e.name);
			const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
			const st = statSync(full);
			if (st.isDirectory()) return walk(full, rel);
			return [`${rel}:${st.size}:${st.mtimeMs}`];
		});
	};
	return walk(dir, "").sort().join("\n");
}

function kebab(key: string): string {
	return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

describe("install --json outcomes (W490.1)", () => {
	test("dry-run plan parses: contractVersion + agent_next_steps + every documented flag", async () => {
		const { code, stdout } = await run(["--json", "--dry-run"]);
		expect(code).toBe(0);
		const doc = JSON.parse(stdout);
		expect(doc.schema).toBe("suspenders.install.v1");
		expect(doc.contractVersion).toBe(1);
		expect(doc.ok).toBe(true);
		expect(Array.isArray(doc.agent_next_steps)).toBe(true);
		expect(doc.agent_next_steps.length).toBeGreaterThan(0);
		for (const key of Object.keys(INSTALL_CONTRACT.flags)) {
			expect(stdout).toContain(INSTALL_CONTRACT.flags[key].flag);
			expect(doc.contract.flags[key].flag).toBe(kebab(key));
		}
		expect(doc.contract.name).toBe("suspenders-install");
		expect(doc.contract.steps).toHaveLength(13);
	});

	test("plan without consent pauses (exit 0, never blocks)", async () => {
		const { code, stdout } = await run(["--json"]);
		expect(code).toBe(0);
		const doc = JSON.parse(stdout);
		expect(doc.outcome).toBe("need_user_action");
		expect(doc.ok).toBe(true);
		expect(doc.pauses.length).toBeGreaterThan(0);
		for (const pause of doc.pauses) {
			expect(pause.resume_command).toContain("install.sh");
		}
	});

	test("contract pause semantics are first-class and frozen", () => {
		expect(INSTALL_CONTRACT.pause.exitCode).toBe(0);
		expect(INSTALL_CONTRACT.pause.statusValue).toBe("need_user_action");
		expect(INSTALL_CONTRACT.pause.resumeField).toBe("resume_command");
	});

	test("--dry-run mutates nothing (temp PREFIX snapshot identical)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "w490-dryrun-"));
		const before = snapshot(dir);
		const { code, stdout } = await run(["--json", "--dry-run"], {
			SUSPENDERS_PREFIX: dir,
		});
		const after = snapshot(dir);
		expect(code).toBe(0);
		expect(after).toBe(before);
		expect(readdirSync(dir)).toHaveLength(0);
		const doc = JSON.parse(stdout);
		expect(doc.paths.prefix).toBe(dir);
	});

	test("every documented step is accepted via --step --dry-run", async () => {
		for (const step of INSTALL_CONTRACT.steps) {
			const { code, stdout } = await run([
				"--step",
				step.name,
				"--dry-run",
				"--json",
			]);
			expect(code).toBe(0);
			const doc = JSON.parse(stdout);
			expect(doc.mode).toBe("step");
			expect(doc.steps).toHaveLength(1);
			expect(doc.steps[0].name).toBe(step.name);
			expect(doc.steps[0].status).toBe(step.mutates ? "planned" : "ok");
		}
	});

	test("unknown step exits 2 and lists the documented names", async () => {
		const { code, stdout } = await run([
			"--step",
			"definitely-not-a-step",
			"--json",
		]);
		expect(code).toBe(2);
		const doc = JSON.parse(stdout);
		expect(doc.outcome).toBe("usage_error");
		expect(doc.error).toContain("probeEnvironment");
		expect(doc.error).toContain("refreshDashboards");
		const actions = doc.agent_next_steps.map((s) => s.action);
		expect(actions).toContain("list-steps");
	});

	test("unknown flag exits 2, JSON path honored, help next step offered", async () => {
		const { code, stdout } = await run(["--nope", "--json"]);
		expect(code).toBe(2);
		const doc = JSON.parse(stdout);
		expect(doc.outcome).toBe("usage_error");
		expect(doc.flags.json).toBe(true);
		expect(doc.error).toContain("--nope");
		const actions = doc.agent_next_steps.map((s) => s.action);
		expect(actions).toContain("help");
	});

	test("probe step runs for real (read-only), detail gated on --verbose", async () => {
		const plain = await run(["--step", "probeEnvironment", "--json"]);
		expect(plain.code).toBe(0);
		const doc = JSON.parse(plain.stdout);
		expect(doc.steps[0].status).toBe("ok");
		expect(doc.steps[0].detail).toBeUndefined();
		const loud = await run([
			"--step",
			"probeEnvironment",
			"--json",
			"--verbose",
		]);
		const loudDoc = JSON.parse(loud.stdout);
		expect(loudDoc.steps[0].detail).toContain("bun");
	});

	test("stub step pauses even with --yes (bash flow not per-step addressable)", async () => {
		const { code, stdout } = await run([
			"--step",
			"wireSettings",
			"--yes",
			"--json",
		]);
		expect(code).toBe(0);
		const doc = JSON.parse(stdout);
		expect(doc.steps[0].status).toBe("need_user_action");
		expect(doc.pauses[0].resume_command).toContain("--wire");
	});
});

describe("contract ⇔ CLI drift checks (W490.1)", () => {
	test("contract flags == meow's accepted flags", () => {
		const contractKeys = Object.keys(INSTALL_CONTRACT.flags).sort();
		const cliKeys = Object.keys(meowFlags).sort();
		expect(cliKeys).toEqual(contractKeys);
	});

	test("flag tokens are kebab-case of the meow keys", () => {
		for (const key of Object.keys(INSTALL_CONTRACT.flags)) {
			expect(INSTALL_CONTRACT.flags[key].flag).toBe(kebab(key));
		}
	});

	test("flag types: step and gateway review are string flags, rest boolean", () => {
		for (const key of Object.keys(meowFlags)) {
			const expected = ["step", "gatewayReview"].includes(key)
				? "string"
				: "boolean";
			expect(meowFlags[key].type).toBe(expected);
		}
	});

	test("step names are unique and fully documented", () => {
		const names = INSTALL_CONTRACT.steps.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
		for (const step of INSTALL_CONTRACT.steps) {
			expect(step.oneLiner.length).toBeGreaterThan(10);
			expect(["real", "delegated", "stub"]).toContain(step.v1);
		}
	});

	test("state pointers are PATHS only — no values that look like secrets", () => {
		for (const v of Object.values(INSTALL_CONTRACT.state)) {
			expect(v.startsWith("~")).toBe(true);
		}
	});
});
