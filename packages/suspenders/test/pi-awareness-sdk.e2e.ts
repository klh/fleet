import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { writeFileSync, realpathSync, existsSync } from "node:fs";
import { join, delimiter, basename } from "node:path";

test("Node Pi SDK discovers Fleet registration and disposes during real startup without an unhandled rejection @unit", async () => {
	const world = scratchWorld({ prefix: "pi-sdk-" });
	try {
		const entry = join(world.home, "awareness.mjs");
		const built = await Bun.build({
			entrypoints: [
				new URL("../pi-extensions/fleet-awareness/index.ts", import.meta.url)
					.pathname,
			],
			target: "node",
			format: "esm",
			outdir: world.home,
			naming: "awareness.mjs",
		});
		expect(built.success).toBe(true);
		const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
		const probe = join(world.home, "probe.mjs");
		writeFileSync(
			probe,
			`import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime} from ${JSON.stringify(sdk)};
import awareness from ${JSON.stringify(entry)};
let starts=0,calls=0;
const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
const resourceLoader=new DefaultResourceLoader({cwd:process.cwd(),agentDir:process.cwd(),settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[(pi)=>{awareness({...pi,exec:async()=>{calls++;await new Promise(r=>setTimeout(r,25));return {stdout:'[]',stderr:'',code:0,killed:false,truncated:false}}});pi.on('session_start',()=>{starts++})}]});
await resourceLoader.reload();
const modelRuntime=await ModelRuntime.create({authPath:process.cwd()+'/auth.json',modelsPath:process.cwd()+'/models.json'});
const {session}=await createAgentSession({cwd:process.cwd(),agentDir:process.cwd(),resourceLoader,settingsManager,modelRuntime,sessionManager:SessionManager.inMemory(process.cwd()),noTools:true});
try{await session.bindExtensions({});const tools=session.getAllTools().map(t=>t.name);session.dispose();await new Promise(r=>setTimeout(r,50));console.log(JSON.stringify({runtime:typeof Bun,starts,calls,tools,errors:resourceLoader.getExtensions().errors}));}finally{session.dispose()}
`,
		);
		const node =
			process.env.FLEET_TEST_NODE_BIN ??
			(process.env.PATH ?? "")
				.split(delimiter)
				.map((dir) => join(dir, "node"))
				.find(
					(file) =>
						existsSync(file) && !basename(realpathSync(file)).startsWith("bun"),
				);
		if (!node)
			throw new Error(
				"Set FLEET_TEST_NODE_BIN to the real Node executable; Bun rewrites node in PATH",
			);
		const child = Bun.spawn([node, probe], {
			cwd: world.home,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
		expect(result).toMatchObject({
			runtime: "undefined",
			starts: 1,
			calls: 3,
			errors: [],
		});
		expect(result.tools).toContain("fleet");
	} finally {
		world.clean();
	}
});
