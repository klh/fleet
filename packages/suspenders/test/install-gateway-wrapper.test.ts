import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const wrapper = join(import.meta.dir, "../install.sh");
test("real canonical wrapper accepts staged approval token and reaches native dry-run without activation", () => {
	const home = mkdtempSync(join(tmpdir(), "gateway-wrapper-"));
	try {
		const result = Bun.spawnSync(
			[
				"/bin/bash",
				wrapper,
				"--step",
				"upgradeGateway",
				"--gateway-review",
				"a".repeat(64),
				"--yes",
				"--json",
				"--dry-run",
			],
			{
				env: {
					...process.env,
					HOME: home,
					PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).toBe(0);
		const outcome = JSON.parse(result.stdout.toString());
		expect(outcome.flags.gatewayReview).toBe("a".repeat(64));
		expect(outcome.steps).toEqual([
			expect.objectContaining({ name: "upgradeGateway", status: "planned" }),
		]);
		expect(existsSync(join(home, "Library/LaunchAgents"))).toBe(false);
		expect(existsSync(join(home, ".config/klh/service-activation.json"))).toBe(
			false,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
test("wrapper forwards approval as one literal argument and rejects missing values", () => {
	const home = mkdtempSync(join(tmpdir(), "gateway-wrapper-args-"));
	try {
		const bin = join(home, "bin"),
			record = join(home, "arguments"),
			marker = join(home, "injected");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "bun"),
			'#!/bin/bash\nprintf "%s\\n" "$@" > "$WRAPPER_ARGUMENTS"\n',
			{ mode: 0o755 },
		);
		const malicious = `$(touch ${marker}); literal`;
		const run = (args: string[]) =>
			Bun.spawnSync(["/bin/bash", wrapper, ...args], {
				env: {
					...process.env,
					HOME: home,
					PATH: `${bin}:${process.env.PATH}`,
					WRAPPER_ARGUMENTS: record,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
		expect(
			run(["--step", "upgradeGateway", "--gateway-review", malicious, "--yes"])
				.exitCode,
		).toBe(0);
		expect(readFileSync(record, "utf8").split("\n")).toContain(malicious);
		expect(existsSync(marker)).toBe(false);
		for (const args of [["--gateway-review"], ["--gateway-review", "--yes"]]) {
			rmSync(record, { force: true });
			expect(run(args).exitCode).toBe(2);
			expect(existsSync(record)).toBe(false);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
