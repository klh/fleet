import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultRenderValues,
	loadManifest,
	renderDarwin,
	validateSpec,
} from "../scripts/install-services.ts";
import { clearInheritedLaunchctlEnv } from "../scripts/install-launchd.ts";

const NAMES = ["BELT_ESCALATE_URL", "BELT_ESCALATE_KEY", "BELT_ESCALATE_MODEL"];

test("belt-swarm clears inherited launchctl escalation before sourcing belt.env", () => {
	if (process.platform !== "darwin") return;
	const home = mkdtempSync(join(tmpdir(), "fleet-belt-env-"));
	try {
		const envPath = join(home, ".claude/local-llm/belt.env");
		mkdirSync(join(home, ".claude/local-llm"), { recursive: true });
		const spec = loadManifest().find(
			(service) => service.name === "belt-swarm",
		);
		expect(spec).toBeDefined();
		if (!spec) return;
		expect(spec.clearInheritedEnv).toEqual(NAMES);
		const unit = join(home, "belt-swarm.plist");
		writeFileSync(unit, renderDarwin(spec, defaultRenderValues({ home })));
		const parsed = Bun.spawnSync([
			"/usr/bin/plutil",
			"-convert",
			"json",
			"-o",
			"-",
			unit,
		]);
		expect(parsed.exitCode).toBe(0);
		const args = (
			JSON.parse(parsed.stdout.toString()) as { ProgramArguments: string[] }
		).ProgramArguments;
		const check =
			"console.log(JSON.stringify([process.env.BELT_ESCALATE_URL ?? null, process.env.BELT_ESCALATE_KEY ?? null, process.env.BELT_ESCALATE_MODEL ?? null]))";
		const inherited = {
			...process.env,
			BELT_ESCALATE_URL: "http://stale:4100",
			BELT_ESCALATE_KEY: "stale-key",
			BELT_ESCALATE_MODEL: "stale-model",
		};
		writeFileSync(
			envPath,
			"BELT_ESCALATE_URL=http://new:4101\nBELT_ESCALATE_KEY=new-key\nBELT_ESCALATE_MODEL=cloud-only\n",
			{ mode: 0o600 },
		);
		const withFile = Bun.spawnSync(
			[...args.slice(0, 5), process.execPath, "-e", check],
			{ env: inherited },
		);
		expect(withFile.exitCode).toBe(0);
		expect(JSON.parse(withFile.stdout.toString())).toEqual([
			"http://new:4101",
			"new-key",
			"cloud-only",
		]);
		writeFileSync(envPath, "# no escalation configured\n");
		const absent = Bun.spawnSync(
			[...args.slice(0, 5), process.execPath, "-e", check],
			{ env: inherited },
		);
		expect(absent.exitCode).toBe(0);
		expect(JSON.parse(absent.stdout.toString())).toEqual([null, null, null]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("renderer refuses shell syntax in clearInheritedEnv", () => {
	const spec = loadManifest().find((service) => service.name === "belt-swarm");
	expect(spec).toBeDefined();
	if (!spec) return;
	expect(() =>
		validateSpec({
			...spec,
			clearInheritedEnv: ["BELT_ESCALATE_KEY; echo bad"],
		}),
	).toThrow("clearInheritedEnv must contain environment variable names");
});

test("installer clears stale global values without printing their contents", async () => {
	const globals = new Map(NAMES.map((name) => [name, `${name}-old-secret`]));
	const calls: string[] = [];
	const run = async (command: string, args: string[]) => {
		expect(command).toBe("/bin/launchctl");
		calls.push(args.join(" "));
		if (args[0] === "unsetenv") {
			globals.delete(args[1]);
			return { exitCode: 0, stdout: "" };
		}
		return { exitCode: 0, stdout: globals.get(args[1]) ?? "" };
	};
	expect(await clearInheritedLaunchctlEnv(NAMES, run)).toBe(true);
	expect(globals.size).toBe(0);
	expect(calls.filter((call) => call.startsWith("unsetenv "))).toHaveLength(3);
	expect(calls.join(" ")).not.toContain("old-secret");
	const stuck = async (_command: string, args: string[]) => ({
		exitCode: 0,
		stdout: args[0] === "getenv" ? "still-set" : "",
	});
	expect(await clearInheritedLaunchctlEnv([NAMES[0]], stuck)).toBe(false);
});
