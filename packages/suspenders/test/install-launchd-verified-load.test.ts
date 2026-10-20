// test/install-launchd-verified-load.test.ts — W576.7: activation publication
// may only bless definitions launchd actually LOADED. A supported writer that
// rewrites the unit between bootstrap and receipt publication (the Oct 7
// buckle-spoke drift: a renderer ran with a different --repo while the
// receipt pinned the prior generation) must refuse the unit — disk bytes
// alone are never adopted, and a next-boot rewrite is detected as drift.
import { expect, test } from "bun:test";
import {
	digestUnit,
	inspectServices,
	parseLoadedArguments,
	readActivation,
	retainActivation,
	type ActivationReceipt,
	type Inspect,
} from "../scripts/lib/service-drift.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parseLoadedArguments reads the launchctl print arguments block", () => {
	const out =
		"\n\targuments = {\n\t\t/bin/sh\n\t\t-c\n\t\texec\n\t}\n\tstate = running\n";
	expect(parseLoadedArguments(out)).toEqual(["/bin/sh", "-c", "exec"]);
});

test("parseLoadedArguments returns null without an arguments block", () => {
	expect(parseLoadedArguments("pid = 42\nstate = running\n")).toBeNull();
});

test("next-boot disk rewrite is drift against the retained receipt", () => {
	const root = mkdtempSync(join(tmpdir(), "w5767-boot-"));
	try {
		const manifest = join(root, "services.yaml");
		const unit = join(root, "board.plist");
		writeFileSync(manifest, "m\n");
		writeFileSync(unit, "rendered\n");
		const receipt: ActivationReceipt = {
			schema: "fleet.service-activation.v1",
			platform: "darwin",
			domain: "gui/501",
			manifest,
			manifestSha256: digestUnit("m\n"),
			services: [
				{
					label: "com.suspenders.board",
					unit,
					unitSha256: digestUnit("rendered\n"),
					arguments: ["/bun", "/board.ts"],
					resident: true,
				},
			],
		};
		const healthy: Inspect = (args) => ({
			code: args[1] === "print-disabled" ? 0 : 1,
			out: "",
			error: "Could not find service com.suspenders.board in gui/501",
		});
		const before = inspectServices(receipt, "gui/501", manifest, healthy);
		expect(before[0].state).toBe("unloaded");
		// next boot: launchd loads DISK bytes — a rewritten unit must be drift
		writeFileSync(unit, "tampered\n");
		const after = inspectServices(receipt, "gui/501", manifest, healthy);
		expect(after[0].state).toBe("drift");
		expect(after[0].reason).toBe(
			"installed unit differs from activation receipt",
		);
		// a re-registration that skips the failed unit retains prior intent
		const kept = retainActivation({ ...receipt, services: [] }, receipt);
		expect(kept.services).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const ctxFixture = (root: string): string => {
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

const tamperScript = `import {mock} from "bun:test";import{mkdirSync,writeFileSync}from"node:fs";import{join}from"node:path";
const home=process.env.HOME;const agents=join(home,"Library/LaunchAgents");mkdirSync(agents,{recursive:true});
mock.module(import.meta.resolve("execa"),()=>({execa:async(command,args)=>{
 if(command===process.execPath){writeFileSync(join(agents,"com.suspenders.board.plist"),"board");return{stdout:JSON.stringify({services:[{service:"board",files:["com.suspenders.board.plist"]}]})};}
 if(command==="bash")return{exitCode:0};
 if(command==="/usr/bin/plutil")return{stdout:JSON.stringify({ProgramArguments:["/bun","/board.ts"],KeepAlive:true})};
 if(command==="/bin/launchctl")return args[0]==="print"?{exitCode:0,stdout:process.env.PRINT_OUT||""}:{exitCode:0};
 if(command==="launchctl")return{exitCode:0};
 throw Error("unexpected subprocess");}}));
const{registerLaunchd}=await import(process.argv[1]);const result=await registerLaunchd(JSON.parse(process.argv[2]));console.log(JSON.stringify(result));`;

const runActivation = async (
	home: string,
	fixture: string,
	printOut: string,
) => {
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			tamperScript,
			join(import.meta.dir, "../scripts/install-launchd.ts"),
			fixture,
		],
		{
			env: { ...process.env, HOME: home, PRINT_OUT: printOut },
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

test("competing writer between load and publication is refused, never adopted", async () => {
	const root = mkdtempSync(join(tmpdir(), "w5767-tamper-"));
	try {
		const home = join(root, "home");
		const fixture = ctxFixture(root);
		// scenario A: launchd loaded a definition a competitor rewrote after load
		const tampered = await runActivation(
			home,
			fixture,
			"\n\targuments = {\n\t\t/bun\n\t\t/tampered.ts\n\t}\n",
		);
		expect(tampered.code).toBe(0);
		const result = JSON.parse(tampered.out);
		expect(result.status).toBe("failed");
		expect(result.note).toContain("com.suspenders.board");
		expect(result.detail).toContain("refused");
		const refusedReceipt = readActivation(
			join(home, ".config/klh/service-activation.json"),
		);
		expect(refusedReceipt.services).toHaveLength(0);
		// scenario B: honest load — the same gate passes and the receipt records it
		const honest = await runActivation(
			home,
			fixture,
			"\n\targuments = {\n\t\t/bun\n\t\t/board.ts\n\t}\n",
		);
		expect(honest.code).toBe(0);
		expect(JSON.parse(honest.out).status).toBe("ok");
		const honestReceipt = readActivation(
			join(home, ".config/klh/service-activation.json"),
		);
		expect(honestReceipt.services.map((s) => s.label)).toEqual([
			"com.suspenders.board",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
