import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routerRuntimeRevision } from "../bin/router-runtime-revision.ts";

const home = mkdtempSync(join(tmpdir(), "router-revision-"));
const entry = join(home, "router-shim.ts");
const dependency = join(home, "http-trace.ts");

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("revision covers imported modules and holds while closure refresh is incomplete", () => {
	writeFileSync(entry, 'import { trace } from "./http-trace.ts"; trace();');
	writeFileSync(dependency, 'export const trace = () => "old";');
	const old = routerRuntimeRevision(entry);
	expect(old).toMatch(/^[0-9a-f]{64}$/);
	writeFileSync(dependency, 'export const trace = () => "new";');
	expect(routerRuntimeRevision(entry)).not.toBe(old);
	mkdirSync(join(home, ".belt-overlay.lock"));
	expect(routerRuntimeRevision(entry)).toBeNull();
	rmSync(join(home, ".belt-overlay.lock"), { recursive: true });
	rmSync(dependency);
	expect(routerRuntimeRevision(entry)).toBeNull();
});
