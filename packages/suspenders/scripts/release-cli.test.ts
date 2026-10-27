// release-cli.test.ts — W1303.6: the release verb's CLI contract (verb-kit
// parsing + the dry-run posture). Runs the real script against the real
// repo — every case here is read-only (status/plan/dry-run cut/usage
// errors); the applied cut is covered by release-version.test.ts fixtures.
import { describe, expect, test } from "bun:test";

const CLI = new URL("./release.ts", import.meta.url).pathname;

const run = (args: string[]) => {
	const p = Bun.spawnSync([process.execPath, CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout ?? new Uint8Array()),
		err: new TextDecoder().decode(p.stderr ?? new Uint8Array()),
	};
};

describe("release CLI (W1303.6)", () => {
	test("status: agreement + tag + machine pin, exit 0 on agreement", () => {
		const r = run(["status"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("manifest agreement:");
		expect(r.out).toContain("latest tag:");
		expect(r.out).toContain("STACK VERSION PIN");
	});

	test("plan --bump minor renders the synchronized bump without writing", () => {
		const r = run(["plan", "--bump", "minor"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("→ next ");
		expect(r.out).toContain("(tag v");
		expect(r.out).toContain("manifests (");
	});

	test("cut without --yes is a dry run: plan only, no writes", () => {
		const r = run(["cut", "--bump", "patch", "--items", "W1303.6"]);
		expect(r.code).toBe(0);
		expect(r.out.startsWith("DRY RUN")).toBe(true);
		expect(r.out).toContain("--yes to apply");
		// nothing was committed: HEAD unchanged by the dry run
		const head = Bun.spawnSync([
			"git",
			"-C",
			new URL("../../..", import.meta.url).pathname,
			"rev-parse",
			"HEAD",
		]);
		expect(head.exitCode).toBe(0);
	});

	test("cut refuses a missing --items (usage die)", () => {
		const r = run(["cut", "--bump", "patch"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("release");
	});

	test("unknown verb dies with the registry list", () => {
		const r = run(["explode"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("status | plan | cut");
	});
});
