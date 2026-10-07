import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectDispatchParity } from "../scripts/lib/dispatch-parity.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function write(path: string, text = "export const helper = true;") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
function fixture(generation: boolean) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-parity-")));
	roots.push(root);
	const repo = join(root, "repo");
	const prefix = join(root, "hooks/suspenders");
	write(join(repo, "packages/suspenders/scripts/lib/helper.ts"));
	if (generation) {
		const payload = join(root, "generation/.harness/packages/suspenders");
		write(join(payload, "hooks/bin/fleet-loop.ts"));
		write(join(payload, "scripts/lib/helper.ts"));
		mkdirSync(prefix, { recursive: true });
		symlinkSync(join(payload, "hooks/bin"), join(prefix, "bin"));
		symlinkSync(join(payload, "scripts"), join(prefix, "scripts"));
		return {
			repo,
			prefix,
			active: join(payload, "scripts/lib/helper.ts"),
			root,
		};
	}
	write(join(prefix, "bin/fleet-loop.ts"));
	write(join(prefix, "scripts/lib/helper.ts"));
	const active = join(root, "hooks/scripts/lib/helper.ts");
	write(active);
	return { repo, prefix, active, root };
}
test("canonical generation ignores unused stale or absent legacy sibling helpers", () => {
	const f = fixture(true);
	expect(inspectDispatchParity(f.repo, f.prefix)).toEqual([]);
	write(join(f.root, "hooks/scripts/lib/helper.ts"), "stale unused helper");
	expect(inspectDispatchParity(f.repo, f.prefix)).toEqual([]);
});
test("canonical generation checks resolved helpers once and detects real drift", () => {
	const f = fixture(true);
	write(f.active, "stale actual helper");
	expect(inspectDispatchParity(f.repo, f.prefix)).toEqual([
		`${f.active} (stale bytes)`,
	]);
	rmSync(f.active);
	expect(inspectDispatchParity(f.repo, f.prefix)).toEqual([f.active]);
});
test("legacy flat install still checks sibling import helpers", () => {
	const f = fixture(false);
	expect(inspectDispatchParity(f.repo, f.prefix)).toEqual([]);
	write(f.active, "stale active legacy helper");
	expect(inspectDispatchParity(f.repo, f.prefix)).toEqual([
		`${f.active} (stale bytes)`,
	]);
});
test("missing installed entry refuses parity rather than hiding dependency loss", () => {
	const f = fixture(true);
	rmSync(join(f.prefix, "bin/fleet-loop.ts"));
	expect(inspectDispatchParity(f.repo, f.prefix)).toEqual([
		`${join(f.prefix, "bin/fleet-loop.ts")} (missing entry)`,
	]);
});
