import { expect, test } from "./pw";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	digestUnit,
	readActivation,
	writeActivation,
} from "../scripts/lib/service-drift.ts";

// W1102: the wired-admission guard reads the private belt.env before any
// unit work — fixtures seed the canonical 0600 guard so receipt assertions
// exercise the activation path they were written for.
const seedBeltGuard = (home: string): void => {
	mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "local-llm", "belt.env"),
		"BELT_WIRED_GUARD_GB=73\n",
		{ mode: 0o600 },
	);
};
test("installer receipt includes only successfully activated services without service operations", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-activation-fixture-"));
	try {
		const repo = join(root, "repo"),
			home = join(root, "home");
		// W631: the fixture models a pinned checkout — a snapshot-shaped tree
		// (no .git) now refuses before rendering any unit.
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, "deploy"), { recursive: true });
		writeFileSync(join(repo, "deploy/services.yaml"), "fixture manifest");
		seedBeltGuard(home);
		const script = `import {mock} from "bun:test";import{mkdirSync,writeFileSync}from"node:fs";import{join}from"node:path";import{createRequire}from"node:module";
const home=process.env.HOME;const agents=join(home,"Library/LaunchAgents");mkdirSync(agents,{recursive:true});let forbidden=false;let phase=0;
mock.module(createRequire(process.argv[1]).resolve("execa"),()=>({execa:async(command,args)=>{
 if(command===process.execPath && args[0].endsWith("/scripts/route-preflight.ts"))return{exitCode:0,stdout:JSON.stringify({ok:true,mode:"live",findings:[],probes:[{reachable:true}],drills:[{ok:true}]})};
 if(command===process.execPath){for(const name of ["board","store-server"])writeFileSync(join(agents,"com.suspenders."+name+".plist"),name);return{stdout:JSON.stringify({services:[{service:"board",files:["com.suspenders.board.plist"]},{service:"store-server",files:["com.suspenders.store-server.plist"]}]})};}
 if(command==="bash")return{exitCode:phase>0 || args[1].includes("store-server")?1:0};
 if(command==="/usr/bin/plutil")return{stdout:JSON.stringify({ProgramArguments:["/bun","/board.ts"],KeepAlive:true})};
 if(command==="/bin/launchctl")return args[0]==="print"?{exitCode:0,stdout:"\\n\\targuments = {\\n\\t\\t/bun\\n\\t\\t/board.ts\\n\\t}\\n"}:{exitCode:0};
 if(command==="launchctl")return{exitCode:0};
 forbidden=true;throw Error("unexpected subprocess");}}));
const{registerLaunchd}=await import(process.argv[1]);const result=await registerLaunchd(JSON.parse(process.argv[2]));phase=1;const second=await registerLaunchd(JSON.parse(process.argv[2]));console.log(JSON.stringify({result,second,forbidden}));`;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				script,
				join(import.meta.dir, "../scripts/install-launchd.ts"),
				JSON.stringify({
					repo,
					prefix: join(root, "prefix"),
					shimBin: join(root, "bin"),
					llmHome: join(root, "models"),
					yes: true,
					dryRun: false,
					json: true,
					verbose: true,
				}),
			],
			{
				env: {
					...process.env,
					HOME: home,
					SUSPENDERS_SERVICE_PORTS_JSON: JSON.stringify({
						"com.suspenders.board": 7799,
					}),
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
		expect(error).toBe("");
		expect(code).toBe(0);
		const report = JSON.parse(out);
		expect(report.forbidden).toBe(false);
		expect(report.result.status).toBe("failed");
		expect(report.second.status).toBe("failed");
		const receipt = readActivation(
			join(home, ".config/klh/service-activation.json"),
		);
		expect(receipt.services.map((service) => service.label)).toEqual([
			"com.suspenders.board",
		]);
		expect(receipt.services[0].port).toBe(7799);
		expect(
			readFileSync(join(home, ".config/klh/service-activation.json"), "utf8"),
		).not.toContain("BELT_TOKEN");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("registration refuses an invalid successful route receipt before rendering", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-route-receipt-"));
	try {
		const repo = join(root, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, "deploy"), { recursive: true });
		writeFileSync(join(repo, "deploy/services.yaml"), "fixture manifest");
		seedBeltGuard(join(root, "home"));
		const script = `import {mock} from "bun:test";import{createRequire}from"node:module";
let rendered=false;mock.module(createRequire(process.argv[1]).resolve("execa"),()=>({execa:async(command,args)=>{
if(command===process.execPath && args[0].endsWith("/scripts/route-preflight.ts"))return{exitCode:0,stdout:JSON.stringify({ok:true,mode:"static",findings:[],probes:[],drills:[{ok:true}]})};
rendered=true;throw Error("rendered after invalid route receipt");}}));
const{registerLaunchd}=await import(process.argv[1]);const result=await registerLaunchd(JSON.parse(process.argv[2]));console.log(JSON.stringify({result,rendered}));`;
		const child = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				script,
				join(import.meta.dir, "../scripts/install-launchd.ts"),
				JSON.stringify({
					repo,
					prefix: join(root, "prefix"),
					shimBin: join(root, "bin"),
					llmHome: join(root, "models"),
					yes: true,
					dryRun: false,
					json: true,
					verbose: true,
				}),
			],
			{
				env: { ...process.env, HOME: join(root, "home") },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(child.exitCode).toBe(0);
		const report = JSON.parse(child.stdout.toString());
		expect(report.result.status).toBe("failed");
		expect(report.result.note).toContain("valid live receipt required");
		expect(report.rendered).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("registration retains a reviewed gateway without loading it again", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-reviewed-registration-"));
	try {
		const repo = join(root, "repo");
		const home = join(root, "home");
		const agents = join(home, "Library/LaunchAgents");
		const unit = join(agents, "com.suspenders.buckle-spoke.plist");
		const receiptPath = join(home, ".config/klh/service-activation.json");
		const generation = {
			root: join(root, "reviewed-generation"),
			revision: "a".repeat(40),
			payloadSha256: "b".repeat(64),
		};
		const body =
			'<plist version="1.0"><dict><key>Label</key><string>com.suspenders.buckle-spoke</string><key>ProgramArguments</key><array><string>/bun</string><string>/reviewed/server.bundle.js</string></array><key>KeepAlive</key><true/></dict></plist>';
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, "deploy"), { recursive: true });
		mkdirSync(agents, { recursive: true });
		writeFileSync(join(repo, "deploy/services.yaml"), "legacyLabels: []");
		writeFileSync(unit, body);
		seedBeltGuard(home);
		writeActivation(receiptPath, {
			schema: "fleet.service-activation.v1",
			platform: "darwin",
			domain: `gui/${process.getuid()}`,
			manifest: join(repo, "deploy/services.yaml"),
			manifestSha256: digestUnit("legacyLabels: []"),
			services: [
				{
					label: "com.suspenders.buckle-spoke",
					unit,
					unitSha256: digestUnit(body),
					arguments: ["/bun", "/reviewed/server.bundle.js"],
					resident: true,
					generation,
				},
			],
		});
		const script = `import {mock} from "bun:test";import{createRequire}from"node:module";
let loads=0;mock.module(createRequire(process.argv[1]).resolve("execa"),()=>({execa:async(command,args)=>{
if(command===process.execPath && args[0].endsWith("/scripts/route-preflight.ts"))return{exitCode:0,stdout:JSON.stringify({ok:true,mode:"live",findings:[],probes:[{reachable:true}],drills:[{ok:true}]})};
if(command===process.execPath)return{stdout:JSON.stringify({services:[{service:"buckle-spoke",files:["com.suspenders.buckle-spoke.plist"],port:4101}]})};
if(command==="bash"){loads++;return{exitCode:0}};
if(command==="/usr/bin/plutil")return{stdout:JSON.stringify({ProgramArguments:["/bun","/reviewed/server.bundle.js"],KeepAlive:true})};
if(command==="/bin/launchctl")return{exitCode:0,stdout:"\\n arguments = {\\n /bun\\n /reviewed/server.bundle.js\\n }\\n"};
if(command==="launchctl")return{exitCode:0};
throw Error("unexpected subprocess");}}));
const{registerLaunchd}=await import(process.argv[1]);const result=await registerLaunchd(JSON.parse(process.argv[2]));console.log(JSON.stringify({result,loads}));`;
		const child = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				script,
				join(import.meta.dir, "../scripts/install-launchd.ts"),
				JSON.stringify({
					repo,
					prefix: join(root, "prefix"),
					shimBin: join(root, "bin"),
					llmHome: join(root, "models"),
					yes: true,
					dryRun: false,
					json: true,
					verbose: true,
				}),
			],
			{ env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
		);
		expect(child.exitCode).toBe(0);
		const result = JSON.parse(child.stdout.toString());
		expect(result.result.status).toBe("ok");
		expect(result.loads).toBe(0);
		expect(readFileSync(unit, "utf8")).toBe(body);
		const retained = readActivation(receiptPath).services.find(
			(service) => service.label === "com.suspenders.buckle-spoke",
		);
		expect(retained?.generation).toEqual(generation);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
