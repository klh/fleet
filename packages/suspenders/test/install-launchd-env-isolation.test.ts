import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearInheritedLaunchctlEnv } from "../scripts/install/install-launchd.ts";
import {
	defaultRenderValues,
	loadManifest,
	renderDarwin,
	validateSpec,
} from "../scripts/install/install-services.ts";
import { readActivation } from "../scripts/lib/service-drift.ts";

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

// W1104: a stale launchctl global that cannot be cleared must refuse the unit
// AND leave the activation receipt without a false activation record.
const activationFixture = (root: string): string => {
	const repo = join(root, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "deploy"), { recursive: true });
	writeFileSync(join(repo, "deploy/services.yaml"), "fixture manifest");
	return JSON.stringify({
		repo,
		prefix: join(root, "prefix"),
		shimBin: join(root, "bin"),
		llmHome: join(root, "models"),
		yes: true,
		dryRun: false,
		json: true,
		verbose: true,
	});
};

const staleActivationScript = `import {mock} from "bun:test";import{mkdirSync,writeFileSync}from"node:fs";import{join}from"node:path";import{createRequire}from"node:module";
const home=process.env.HOME;const agents=join(home,"Library/LaunchAgents");mkdirSync(agents,{recursive:true});
const stale=new Map([["BELT_ESCALATE_URL","http://stale:4100"]]);
mock.module(createRequire(process.argv[1]).resolve("execa"),()=>({execa:async(command,args)=>{
 if(command===process.execPath&&args[0].endsWith("/scripts/route-preflight.ts"))return{exitCode:0,stdout:JSON.stringify({ok:true,mode:"live",findings:[],probes:[{reachable:true}],drills:[{ok:true}]})};
 if(command===process.execPath){writeFileSync(join(agents,"com.suspenders.board.plist"),"board");return{stdout:JSON.stringify({services:[{service:"board",files:["com.suspenders.board.plist"],clearInheritedEnv:["BELT_ESCALATE_URL"]}]})};}
 if(command==="bash")return{exitCode:0};
 if(command==="/usr/bin/plutil")return{stdout:JSON.stringify({ProgramArguments:["/bun","/board.ts"],KeepAlive:true})};
 if(command==="/bin/launchctl"){
  if(args[0]==="print")return{exitCode:0,stdout:process.env.PRINT_OUT||""};
  if(args[0]==="getenv")return{exitCode:0,stdout:process.env.STUCK==="1"?(stale.get(args[1])??""):(stale.delete(args[1]),"")};
  if(args[0]==="unsetenv"){if(process.env.STUCK!=="1")stale.delete(args[1]);return{exitCode:0,stdout:""};}
 }
 if(command==="launchctl")return{exitCode:0};
 throw Error("unexpected subprocess");}}));
const{registerLaunchd}=await import(process.argv[1]);const result=await registerLaunchd(JSON.parse(process.argv[2]));console.log(JSON.stringify(result));`;

const runStaleActivation = async (
	home: string,
	fixture: string,
	stuck: boolean,
) => {
	// W1102: the wired-admission guard reads the private belt.env before any
	// unit work — seed the canonical 0600 guard so the refusal under test is
	// the stale-env one.
	mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "local-llm", "belt.env"),
		"BELT_WIRED_GUARD_GB=73\n",
		{ mode: 0o600 },
	);
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			staleActivationScript,
			join(import.meta.dir, "../scripts/install/install-launchd.ts"),
			fixture,
		],
		{
			env: {
				...process.env,
				HOME: home,
				PRINT_OUT: "\n\targuments = {\n\t\t/bun\n\t\t/board.ts\n\t}\n",
				STUCK: stuck ? "1" : "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, out, error] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, out, error };
};

test("unclearable stale launchctl global refuses activation and records no receipt service", async () => {
	const root = mkdtempSync(join(tmpdir(), "w1104-receipt-"));
	try {
		const fixture = activationFixture(root);
		const stuckHome = join(root, "stuck");
		const stuck = await runStaleActivation(stuckHome, fixture, true);
		expect(stuck.code).toBe(0);
		const stuckResult = JSON.parse(stuck.out);
		expect(stuckResult.status).toBe("failed");
		expect(stuckResult.detail).toContain(
			"stale launchctl environment could not be cleared",
		);
		const stuckReceipt = readActivation(
			join(stuckHome, ".config/klh/service-activation.json"),
		);
		expect(stuckReceipt.services).toHaveLength(0);
		// positive control: clearable stale globals proceed and get recorded
		const honestHome = join(root, "honest");
		const honest = await runStaleActivation(honestHome, fixture, false);
		expect(honest.code).toBe(0);
		expect(JSON.parse(honest.out).status).toBe("ok");
		const honestReceipt = readActivation(
			join(honestHome, ".config/klh/service-activation.json"),
		);
		expect(honestReceipt.services.map((service) => service.label)).toEqual([
			"com.suspenders.board",
		]);
	} finally {
		rmSync(root, { recursive: true, now: true });
	}
});
