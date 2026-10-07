import { expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertServiceActivation } from "../scripts/lib/service-activation-fence.ts";
import {
	digestUnit,
	type ActivationReceipt,
} from "../scripts/lib/service-drift.ts";

function fixture() {
	const args = [process.execPath, "/reviewed/worktree/server.ts"],
		candidate = "approved unit",
		manifest = "approved manifest";
	const receipt: ActivationReceipt = {
		schema: "fleet.service-activation.v1",
		platform: "darwin",
		domain: "gui/501",
		manifest: "/manifest",
		manifestSha256: digestUnit(manifest),
		services: [
			{
				label: "com.suspenders.buckle-spoke",
				unit: "/unit",
				unitSha256: digestUnit(candidate),
				arguments: args,
				resident: true,
			},
		],
	};
	return { args, candidate, manifest, receipt };
}
test("matching existing approved receipt authorizes without inventing code provenance", () => {
	const f = fixture();
	expect(() =>
		assertServiceActivation(
			f.receipt,
			"com.suspenders.buckle-spoke",
			f.candidate,
			f.args,
			f.manifest,
			"gui/501",
		),
	).not.toThrow();
});
test("competing writer cannot replace approved unit or gateway entry", () => {
	const f = fixture();
	expect(() =>
		assertServiceActivation(
			f.receipt,
			"com.suspenders.buckle-spoke",
			"competing unit",
			[process.execPath, "/mutable/main/server.ts"],
			f.manifest,
			"gui/501",
		),
	).toThrow();
	expect(() =>
		assertServiceActivation(
			f.receipt,
			"com.suspenders.buckle-spoke",
			f.candidate,
			[process.execPath, "/mutable/main/server.ts"],
			f.manifest,
			"gui/501",
		),
	).toThrow();
});
test("wrong domain, changed manifest and missing authority refuse", () => {
	const f = fixture();
	expect(() =>
		assertServiceActivation(
			f.receipt,
			"com.suspenders.buckle-spoke",
			f.candidate,
			f.args,
			f.manifest,
			"gui/999",
		),
	).toThrow();
	expect(() =>
		assertServiceActivation(
			f.receipt,
			"com.suspenders.buckle-spoke",
			f.candidate,
			f.args,
			"changed manifest",
			"gui/501",
		),
	).toThrow();
	f.receipt.services = [];
	expect(() =>
		assertServiceActivation(
			f.receipt,
			"com.suspenders.buckle-spoke",
			f.candidate,
			f.args,
			f.manifest,
			"gui/501",
		),
	).toThrow();
});
test("raw copied candidate through load-launchd is refused before any plutil or launchctl action", () => {
	const home = mkdtempSync(join(tmpdir(), "loader-fence-"));
	try {
		const bin = join(home, "bin"),
			agents = join(home, "Library/LaunchAgents"),
			calls = join(home, "calls");
		mkdirSync(bin);
		mkdirSync(agents, { recursive: true });
		for (const command of ["launchctl", "plutil"])
			writeFileSync(
				join(bin, command),
				`#!/bin/sh\necho ${command} >> '${calls}'\nexit 0\n`,
				{ mode: 0o755 },
			);
		const unit = join(agents, "com.suspenders.buckle-spoke.plist");
		const copied = `<plist version="1.0"><dict><key>Label</key><string>com.suspenders.buckle-spoke</string><key>ProgramArguments</key><array><string>/mutable/main/server.ts</string></array></dict></plist>`;
		writeFileSync(unit, copied);
		const result = Bun.spawnSync(
			[
				"/bin/bash",
				join(import.meta.dir, "../scripts/load-launchd.sh"),
				unit,
				join(home, "log"),
			],
			{
				env: {
					...process.env,
					HOME: home,
					PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
					SUSPENDERS_PREFIX: join(home, "missing-prefix"),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("activation refused");
		expect(Bun.file(calls).size).toBe(0);
		expect(readFileSync(unit, "utf8")).toBe(copied);
		const renamed = join(agents, "com.test.alias.plist");
		writeFileSync(renamed, copied);
		const disguised = Bun.spawnSync(
			[
				"/bin/bash",
				join(import.meta.dir, "../scripts/load-launchd.sh"),
				renamed,
				join(home, "log"),
			],
			{
				env: {
					...process.env,
					HOME: home,
					PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(disguised.exitCode).not.toBe(0);
		expect(Bun.file(calls).size).toBe(0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("initial owner install needs confirmed absence and never bypasses existing receipt", () => {
	const f = fixture();
	expect(() =>
		assertServiceActivation(
			undefined,
			"com.suspenders.buckle-spoke",
			f.candidate,
			f.args,
			f.manifest,
			"gui/501",
			true,
			true,
		),
	).not.toThrow();
	expect(() =>
		assertServiceActivation(
			undefined,
			"com.suspenders.buckle-spoke",
			f.candidate,
			f.args,
			f.manifest,
			"gui/501",
			true,
			false,
		),
	).toThrow();
	expect(() =>
		assertServiceActivation(
			f.receipt,
			"com.suspenders.buckle-spoke",
			"competing",
			f.args,
			f.manifest,
			"gui/501",
			true,
			true,
		),
	).toThrow();
});

test("active renderer refuses before overwriting a copied unit; inspection rendering remains available", () => {
	const home = mkdtempSync(join(tmpdir(), "renderer-fence-"));
	try {
		const agents = join(home, "Library/LaunchAgents");
		mkdirSync(agents, { recursive: true });
		const unit = join(agents, "com.suspenders.buckle-spoke.plist");
		writeFileSync(unit, "existing approved unit");
		const args = [
			join(import.meta.dir, "../scripts/install-services.ts"),
			"--target",
			"darwin",
			"--service",
			"buckle-spoke",
			"--home",
			home,
		];
		const env = {
			...process.env,
			HOME: home,
			SUSPENDERS_PREFIX: join(home, "missing-prefix"),
		};
		const denied = Bun.spawnSync([process.execPath, ...args, "--out", agents], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(denied.exitCode).not.toBe(0);
		expect(readFileSync(unit, "utf8")).toBe("existing approved unit");
		const inspection = Bun.spawnSync([process.execPath, ...args], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(inspection.exitCode).toBe(0);
		expect(inspection.stdout.toString()).toContain(
			"com.suspenders.buckle-spoke",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
