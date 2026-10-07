// spawner.test.ts — W508: the kit↔belt spawner DRY contract. The kit
// spawner is a re-export of belt's (the registry.ts pattern) — never a
// byte-twin again; belt's file is the ONE source and install.sh flattens
// it into the runtime home so the flat imports resolve there.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const kitSpawner = new URL("./spawner.ts", import.meta.url).pathname;
const beltSpawner = new URL("../belt/bin/spawner.ts", import.meta.url).pathname;
const installSh = new URL("../suspenders/install.sh", import.meta.url).pathname;

test("kit spawner.ts is the belt re-export, not a twin", () => {
	const src = readFileSync(kitSpawner, "utf8");
	// refresh-gateway.ts keys on this exact shape when upgrading the
	// runtime home — drift here breaks the flatten upgrade path.
	expect(src).toContain('export * from "../belt/bin/spawner.ts"');
	// a resurrected twin would show up as re-grown source
	expect(src.split("\n").length).toBeLessThanOrEqual(10);
});

test("belt/bin/spawner.ts is the single source of the lifecycle", () => {
	const src = readFileSync(beltSpawner, "utf8");
	expect(src).toContain("export function ensureUp");
	expect(src).toContain("export function spawnReserved");
});

test("install.sh flattens belt's spawner into the runtime home", () => {
	const sh = readFileSync(installSh, "utf8");
	// the belt/bin flatten list must carry spawner + its admission dep,
	// else the flat home keeps a stale twin or an unresolvable re-export
	expect(sh).toMatch(/for f in [^\n]*spawner\.ts spawn-admission\.ts/);
});
