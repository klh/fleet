import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readActivation } from "../scripts/lib/service-drift.ts";
test("installer receipt includes only successfully activated services without service operations", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-activation-fixture-"));
	try {
		const repo = join(root, "repo"),
			home = join(root, "home");
		mkdirSync(join(repo, "deploy"), { recursive: true });
		writeFileSync(join(repo, "deploy/services.yaml"), "fixture manifest");
		const script = `import {mock} from "bun:test";import{mkdirSync,writeFileSync}from"node:fs";import{join}from"node:path";
const home=process.env.HOME;const agents=join(home,"Library/LaunchAgents");mkdirSync(agents,{recursive:true});let forbidden=false;let phase=0;
mock.module("execa",()=>({execa:async(command,args)=>{
 if(command===process.execPath){for(const name of ["board","store-server"])writeFileSync(join(agents,"com.suspenders."+name+".plist"),name);return{stdout:JSON.stringify({services:[{service:"board",files:["com.suspenders.board.plist"]},{service:"store-server",files:["com.suspenders.store-server.plist"]}]})};}
 if(command==="bash")return{exitCode:phase>0 || args[1].includes("store-server")?1:0};
 if(command==="/usr/bin/plutil")return{stdout:JSON.stringify({ProgramArguments:["/bun","/board.ts"],KeepAlive:true})};
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
