// spawner.test.ts — W508: the kit↔belt spawner DRY contract. The kit
// spawner is a re-export of belt's (the registry.ts pattern) — never a
// byte-twin again; belt's file is the ONE source and install.sh flattens
// it into the runtime home so the flat imports resolve there.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const kitSpawner = new URL("./spawner.ts", import.meta.url).pathname;
const beltSpawner = new URL("../belt/bin/spawner.ts", import.meta.url).pathname;

test("kit spawner.ts is the belt re-export, not a twin", () => {
	const src = readFileSync(kitSpawner, "utf8");
	// the flat runtime home imports the spawner relatively — drift here
	// breaks the flatten upgrade path.
	expect(src).toContain('export * from "../belt/bin/spawner.ts"');
	// a resurrected twin would show up as re-grown source
	expect(src.split("\n").length).toBeLessThanOrEqual(10);
});

test("belt/bin/spawner.ts is the single source of the lifecycle", () => {
	const src = readFileSync(beltSpawner, "utf8");
	expect(src).toContain("export function ensureUp");
	expect(src).toContain("export function spawnReserved");
});

test("install heals the runtime home's belt closure (native flags)", () => {
	// W771.3: install.sh is a pure exec wrapper — the W661 flatten (closure
	// walk + smoke self-check) lives in install-llm-steps.ts. Without it the
	// flat home keeps a stale twin or an unresolvable re-export and :4000
	// loops on launchd revives.
	const steps = readFileSync(
		new URL("../suspenders/scripts/install-llm-steps.ts", import.meta.url)
			.pathname,
		"utf8",
	);
	expect(steps).toContain('join(beltBin(ctx), "swarm.ts")');
	expect(steps).toContain('join(beltBin(ctx), "router-shim.ts")');
	expect(steps).toContain("smokeRouter(ctx.llmHome)");
});
