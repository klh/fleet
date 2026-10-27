// tests/helpers/config-centralization.ts — W2173.5.3: helpers for
// tests/config-centralization.e2e.ts (spec files carry only imports and
// test registrations — the transform here rejects helper declarations in
// spec files). scanStandaloneConfigs walks the tree for
// playwright.config.ts files and reports any that do not extend
// defineFleetConfig.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function scanStandaloneConfigs(root: string): string[] {
	const offenders: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === ".git") continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				walk(path);
				continue;
			}
			if (!path.endsWith("playwright.config.ts")) continue;
			const src = readFileSync(path, "utf8");
			if (
				src.includes("defineConfig(") ||
				!src.includes("defineFleetConfig(")
			) {
				offenders.push(path);
			}
		}
	};
	walk(root);
	return offenders;
}
