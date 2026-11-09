import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { writeFileSync, realpathSync, existsSync } from "node:fs";
import { join, delimiter, basename } from "node:path";
import { installPiAwareness } from "../scripts/install/install-pi-awareness.ts";

test("Node Pi SDK discovers Fleet registration and disposes during real startup without an unhandled rejection @unit", async () => {
	const world = scratchWorld({ prefix: "pi-sdk-" });
	try {
		expect(await installPiAwareness({ piHome: world.home })).toMatchObject({
			status: "ok",
		});
		writeFileSync(
			join(world.home, "extensions/fleet-statusline.ts"),
			'export default function(pi) { pi.registerCommand("fleet", { description: "Status widget", handler: async () => {} }); }',
		);
		for (const command of ["coord", "work"])
			writeFileSync(
				join(world.home, command),
				"#!/bin/sh\n/bin/sleep 0.1\nprintf '[]'\n",
				{ mode: 0o700 },
			);
		const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
		const probe = join(world.home, "probe.mjs");
		writeFileSync(
			probe,
			`import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime} from ${JSON.stringify(sdk)};
let statusWrites=0;
const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
const resourceLoader=new DefaultResourceLoader({cwd:process.cwd(),agentDir:process.cwd(),settingsManager,noSkills:true,noPromptTemplates:true,noThemes:true});
await resourceLoader.reload();
const modelRuntime=await ModelRuntime.create({authPath:process.cwd()+'/auth.json',modelsPath:process.cwd()+'/models.json'});
const {session}=await createAgentSession({cwd:process.cwd(),agentDir:process.cwd(),resourceLoader,settingsManager,modelRuntime,sessionManager:SessionManager.inMemory(process.cwd()),noTools:true});
let tools;try{await session.bindExtensions({uiContext:{setStatus:()=>{statusWrites++}}});tools=session.getAllTools().map(t=>t.name);}finally{session.dispose()}
await new Promise(r=>setTimeout(r,250));
const loaded=resourceLoader.getExtensions();
console.log(JSON.stringify({runtime:typeof Bun,tools,statusWrites,panelCommands:loaded.extensions.filter(e=>e.commands.has("fleetpanel")).length,widgetCommands:loaded.extensions.filter(e=>e.commands.has("fleet")).length,errors:loaded.errors}));
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
			env: { HOME: world.home, PATH: world.home },
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
			panelCommands: 1,
			widgetCommands: 1,
			statusWrites: 0,
			errors: [],
		});
		expect(result.tools).toContain("fleet");
	} finally {
		world.clean();
	}
});
