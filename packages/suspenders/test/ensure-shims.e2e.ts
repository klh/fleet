// test/ensure-shims.test.ts — W771.1: the native ensureShims step. Covers the
// standalone step impl (target guard, symlink refusal, rollback, idempotency)
// and the plan-runner routing (v1 real via --step).
import { expect, test } from "@playwright/test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StepContext } from "../scripts/install-run.ts";
import {
	SHIM_NAMES,
	ensureShims,
	planShims,
	restoreShims,
	shimScript,
	writeShims,
} from "../scripts/ensure-shims.ts";

const roots: string[] = [];
test.afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function ctx(prefixReady: boolean): StepContext {
	const root = mkdtempSync(join(tmpdir(), "fleet-ensure-shims-"));
	roots.push(root);
	const c: StepContext = {
		repo: join(root, "repo"),
		prefix: join(root, "state/harness"),
		shimBin: join(root, "shims"),
		llmHome: join(root, "models"),
		dryRun: false,
		yes: true,
		json: true,
		verbose: false,
	};
	if (prefixReady) {
		mkdirSync(join(c.prefix, "bin"), { recursive: true });
		mkdirSync(join(c.prefix, "scripts"), { recursive: true });
		writeFileSync(join(c.prefix, "bin/coord.ts"), "export const value = 1;");
		writeFileSync(
			join(c.prefix, "scripts/dispatch-next.ts"),
			"export const value = 1;",
		);
	}
	return c;
}

test("ensureShims writes every shim against the live prefix, idempotent", async () => {
	const c = ctx(true);
	const first = await ensureShims(c);
	expect(first.status).toBe("ok");
	expect(first.note).toContain(`into ${c.shimBin}`);
	for (const name of SHIM_NAMES) {
		const path = join(c.shimBin, name);
		expect(existsSync(path)).toBe(true);
		expect(lstatSync(path).isSymbolicLink()).toBe(false);
		expect(statSync(path).mode & 0o777).toBe(0o755);
	}
	const dispatch = readFileSync(join(c.shimBin, "dispatch"), "utf8");
	expect(dispatch).toBe(shimScript(c.prefix, "dispatch"));
	expect(dispatch).toContain(join(c.prefix, "scripts/dispatch-next.ts"));
	const coord = readFileSync(join(c.shimBin, "coord"), "utf8");
	expect(coord).toContain(join(c.prefix, "bin/coord.ts"));
	const second = await ensureShims(c);
	expect(second.status).toBe("ok");
});

test("dangling shims refused when the harness prefix is missing", async () => {
	const c = ctx(false);
	const result = await ensureShims(c);
	expect(result.status).toBe("failed");
	expect(result.note).toContain("syncHarness step first");
});

test("symlink shims are refused before any write", async () => {
	const c = ctx(true);
	mkdirSync(c.shimBin, { recursive: true });
	// live symlink (dangling links get replaced, matching the sync-time rule)
	symlinkSync(join(c.prefix, "bin/coord.ts"), join(c.shimBin, "work"));
	await expect(ensureShims(c)).rejects.toThrow("Refusing symlink shim: work");
	expect(existsSync(join(c.shimBin, "coord"))).toBe(false);
});

test("a shim write failure restores the previous wrappers", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-shim-rollback-"));
	roots.push(root);
	const shimBin = join(root, "shims");
	mkdirSync(shimBin);
	writeFileSync(join(shimBin, "coord"), "original coord");
	writeFileSync(join(shimBin, "work"), "original work");
	const shims = planShims(shimBin);
	expect(() =>
		writeShims("/new/prefix", shims, (source, destination) => {
			if (destination === join(shimBin, "work"))
				throw new Error("publication denied");
			renameSync(source, destination);
		}),
	).toThrow("publication denied");
	// writeShims stops at the failure; rollback is the caller's leg (restoreShims)
	expect(readFileSync(join(shimBin, "coord"), "utf8")).toBe(
		shimScript("/new/prefix", "coord"),
	);
	expect(readFileSync(join(shimBin, "work"), "utf8")).toBe("original work");
	restoreShims(shims);
	expect(readFileSync(join(shimBin, "coord"), "utf8")).toBe("original coord");
	expect(readFileSync(join(shimBin, "work"), "utf8")).toBe("original work");
});

test("executePlan routes --step ensureShims as a real step", async () => {
	const { executePlan } = await import("../scripts/install-run.ts");
	const c = ctx(true);
	const result = await executePlan("step", "ensureShims", c, () => {});
	expect(result.outcome).toBe("ok");
	expect(result.rows.map((r) => r.name)).toEqual(["ensureShims"]);
	expect(result.rows[0].status).toBe("ok");
	expect(existsSync(join(c.shimBin, "dispatch"))).toBe(true);
});
