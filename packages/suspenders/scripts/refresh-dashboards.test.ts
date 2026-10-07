import { expect, test } from "bun:test";
import { join } from "node:path";
import { dashboardCodeGroups } from "./refresh-dashboards.ts";

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
