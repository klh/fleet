import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLaunchd } from "../scripts/install-launchd.ts";
import { validateBeltWiredGuard } from "../scripts/lib/belt-wired-guard.ts";
import type { StepContext } from "../scripts/install-run.ts";
import { loadManifest, renderDarwin } from "../scripts/install-services.ts";
import { parsePlistXml } from "./plist-fields.ts";

test("fresh prefix sources the same private guard value for Belt and dispatch", () => {
	const root = mkdtempSync(join(tmpdir(), "install-wired-guard-"));
	try {
		const home = join(root, "home");
		const file = join(home, ".claude", "local-llm", "belt.env");
		mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
		writeFileSync(file, "BELT_WIRED_GUARD_GB=73\n", { mode: 0o600 });
		const guard = validateBeltWiredGuard(file);
		expect(guard).toEqual({ ok: true, value: "73" });
		const spec = loadManifest().find(
			(service) => service.name === "belt-swarm",
		);
		if (!spec) throw new Error("belt-swarm manifest entry missing");
		const xml = renderDarwin(spec, {
			bun: process.execPath,
			home,
			prefix: join(home, ".claude", "hooks", "suspenders"),
			repo: join(root, "packages", "suspenders"),
			beltUrl: "http://127.0.0.1:4100",
			beltToken: "",
		});
		const plist = parsePlistXml(xml);
		expect(
			(plist.EnvironmentVariables as Record<string, string>)
				.BELT_WIRED_GUARD_GB,
		).toBeUndefined();
		const args = plist.ProgramArguments as string[];
		const sourced = Bun.spawnSync(
			[
				...args.slice(0, 5),
				"/bin/sh",
				"-c",
				'printf "%s" "$BELT_WIRED_GUARD_GB"',
			],
			{
				env: { ...process.env, BELT_WIRED_GUARD_GB: "12" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(sourced.exitCode).toBe(0);
		expect(sourced.stdout.toString()).toBe(guard.ok ? guard.value : "");
		expect(readFileSync(file, "utf8")).toBe("BELT_WIRED_GUARD_GB=73\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing, invalid, duplicate, and nonprivate guards are refused", async () => {
	const root = mkdtempSync(join(tmpdir(), "install-wired-refuse-"));
	try {
		const home = join(root, "home");
		const repo = join(root, "packages", "suspenders");
		const file = join(home, ".claude", "local-llm", "belt.env");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
		const ctx: StepContext = {
			home,
			llmHome: join(home, ".claude", "local-llm"),
			repo,
			prefix: join(home, ".claude", "hooks", "suspenders"),
			shimBin: join(home, ".local", "bin"),
			dryRun: false,
			yes: true,
			json: true,
			verbose: false,
			wireRepo: null,
		};
		const refusesRegistration = async (): Promise<void> => {
			if (process.platform !== "darwin") return;
			const result = await registerLaunchd(ctx);
			expect(result.status).toBe("failed");
			expect(result.note).toMatch(/belt.env|BELT_WIRED_GUARD_GB/);
		};
		expect(validateBeltWiredGuard(file).ok).toBe(false);
		await refusesRegistration();
		for (const body of [
			"BELT_WIRED_GUARD_GB=\n",
			"BELT_WIRED_GUARD_GB=bogus\n",
			"BELT_WIRED_GUARD_GB=0\n",
			"BELT_WIRED_GUARD_GB=73\nBELT_WIRED_GUARD_GB=74\n",
			"BELT_WIRED_GUARD_GB=73\nexport BELT_WIRED_GUARD_GB=74\n",
			`BELT_WIRED_GUARD_GB=${"9".repeat(400)}\n`,
		]) {
			writeFileSync(file, body, { mode: 0o600 });
			expect(validateBeltWiredGuard(file).ok).toBe(false);
			await refusesRegistration();
		}
		writeFileSync(file, "BELT_WIRED_GUARD_GB=73\n");
		chmodSync(file, 0o644);
		expect(validateBeltWiredGuard(file).ok).toBe(false);
		await refusesRegistration();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
