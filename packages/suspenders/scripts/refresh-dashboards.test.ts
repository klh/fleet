import { expect, test } from "bun:test";
import { dashboardCodeGroups } from "./refresh-dashboards.ts";

test("Belt refresh carries UI modules and leaves installed runtime machinery alone", () => {
	const group = dashboardCodeGroups.find((row) => row.package === "belt/bin");
	if (!group) throw new Error("belt publication group missing");
	const published = new Set<string>(group.files);
	for (const file of [
		"dashboard.ts",
		"model-access.ts",
		"dashboard-state.ts",
		"dashboard-observability.js",
		"dashboard-topology.js",
		"dashboard-topology-model.js",
		"vendor/lit.js",
	])
		expect(published.has(file), `missing UI module ${file}`).toBe(true);
	// The flat runtime home has machine-specific remotes/hubs modules. Copying
	// their repo versions breaks ../../suspenders imports at publication time.
	for (const file of ["remotes.ts", "hubs.ts", "registry.ts"])
		expect(
			published.has(file),
			`runtime module ${file} must stay installer-owned`,
		).toBe(false);
});

test("local refresh carries the page and its direct visual dependencies", () => {
	const group = dashboardCodeGroups.find((row) => row.package === "local/bin");
	if (!group) throw new Error("local publication group missing");
	for (const file of [
		"dashboard.ts",
		"dashboard-page.html",
		"klh-theme.ts",
		"vendor/lit-shared.js",
	])
		expect(group.files.includes(file), `missing local UI file ${file}`).toBe(
			true,
		);
	expect(group.files.includes("klh-local.ts")).toBe(false);
});
