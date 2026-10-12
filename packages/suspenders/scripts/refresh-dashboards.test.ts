import { expect, test } from "bun:test";
import { join } from "node:path";
import { beltBinClosure } from "./belt-bin-overlay.ts";
import { dashboardCodeGroups } from "./refresh-dashboards.ts";

test("belt dashboard publication covers the complete import closure", async () => {
	const group = dashboardCodeGroups.find((row) => row.package === "belt/bin");
	if (!group) throw new Error("belt publication group missing");
	const closure = await beltBinClosure(
		join(import.meta.dir, "../../belt/bin/dashboard.ts"),
	);
	const published = new Set<string>(group.files);
	// belt/bin memory-policy.ts + observation.ts are repo-side re-export
	// shims of the local-llm kit files; the flat runtime home carries the
	// real implementations, so the manifest must not copy the shims over.
	const runtimeShims = new Set(["memory-policy.ts", "observation.ts"]);
	for (const file of closure) {
		if (runtimeShims.has(file)) continue;
		expect(published.has(file), `missing closure file ${file}`).toBe(true);
	}
	expect(published.has("dashboard-observability.js")).toBe(true);
	expect(published.has("vendor/lit.js")).toBe(true);
});

test("local CLI runtime publication includes the complete relative module closure", async () => {
	const group = dashboardCodeGroups.find((row) => row.package === "local/bin");
	if (!group) throw new Error("local publication group missing");
	// Observation is published into both destinations by the shared copy pass.
	const published = new Set<string>([...group.files, "observation.ts"]);
	const pending = ["klh-local.ts"];
	const visited = new Set<string>();
	while (pending.length) {
		const name = pending.pop();
		if (!name || visited.has(name)) continue;
		visited.add(name);
		const source = await Bun.file(
			join(import.meta.dir, "../../local/bin", name),
		).text();
		for (const match of source.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
			const dependency = match[1];
			expect(published.has(dependency), `${name} imports ${dependency}`).toBe(
				true,
			);
			pending.push(dependency);
		}
	}
	expect(visited.has("dns-maintenance.ts")).toBe(true);
});
