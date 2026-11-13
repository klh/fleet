// test/qlty-on-write@unit.e2e.ts — W3059: pi's face of the fleet on-write
// qlty gate. Covers the pure core (skip/change/note decisions), the REAL
// runQltyFmt face against a stubbed qlty on PATH (exit 99 silent skip +
// byte rewrite), the loadable default export, and the generalized
// installPiExtensions sync (planned → synced → current for every repo
// pi extension, with installPiReceiver kept compatible for W2863 pins).
import {
	mkdirSync,
	mkdtempSync,
	writeFileSync,
	chmodSync,
	existsSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	qltyFmtOnWrite,
	runQltyFmt,
	default as qltyOnWrite,
} from "../pi-extensions/qlty-on-write/index.ts";
import {
	installPiExtensions,
	installPiReceiver,
	piExtensionNames,
} from "../scripts/install/install-pi-receiver.ts";

function home(label: string): string {
	return mkdtempSync(join(tmpdir(), `qlty-on-write-${label}-`));
}

test.describe("qltyFmtOnWrite pure core", () => {
	const file = "/repo/src/thing.ts";
	const sizeOf = () => 10;
	const runFmt = () => 0;

	test("skips non-write tools, errored results, and missing paths", () => {
		expect(
			qltyFmtOnWrite("bash", { command: "x" }, false, "/", runFmt, sizeOf),
		).toBeUndefined();
		expect(
			qltyFmtOnWrite("read", { path: file }, false, "/", runFmt, sizeOf),
		).toBeUndefined();
		expect(
			qltyFmtOnWrite("edit", { path: file }, true, "/", runFmt, sizeOf),
		).toBeUndefined();
		expect(
			qltyFmtOnWrite("edit", {}, false, "/", runFmt, sizeOf),
		).toBeUndefined();
	});

	test("exit 99 (no qlty setup) skips silently", () => {
		expect(
			qltyFmtOnWrite("write", { path: file }, false, "/", () => 99, sizeOf),
		).toBeUndefined();
	});

	test("a throwing fmt (qlty absent) skips silently", () => {
		expect(
			qltyFmtOnWrite(
				"write",
				{ path: file },
				false,
				"/",
				() => {
					throw new Error("ENOENT");
				},
				sizeOf,
			),
		).toBeUndefined();
	});

	test("changed bytes produce the re-read note with the delta", () => {
		let n = 10;
		const o = qltyFmtOnWrite(
			"edit",
			{ path: file },
			false,
			"/",
			runFmt,
			() => (n -= 3), // 10 → 7: fmt shrank the file
		);
		expect(o?.changed).toBe(true);
		expect(o?.delta).toBe(-3);
		expect(o?.note).toContain("thing.ts");
		expect(o?.note).toContain("re-read");
	});

	test("unchanged bytes report no note", () => {
		const o = qltyFmtOnWrite(
			"write",
			{ path: file },
			false,
			"/",
			runFmt,
			sizeOf,
		);
		expect(o?.changed).toBe(false);
		expect(o?.note).toBe("");
	});
});

test.describe("runQltyFmt real face (stubbed qlty on PATH)", () => {
	test("rewrites bytes through a stub qlty and exits by status", async () => {
		const world = home("stub");
		const bin = join(world, "bin");
		const repo = join(world, "repo");
		mkdirSync(bin, { recursive: true });
		mkdirSync(join(repo, ".qlty"), { recursive: true });
		mkdirSync(join(repo, "src"), { recursive: true });
		const target = join(repo, "src", "ugly.ts");
		writeFileSync(target, "const  x   =   1;\n");
		// stub qlty: `fmt` rewrites the named file, `fmt --probe` exits 99
		const stub = join(bin, "qlty");
		writeFileSync(
			stub,
			`#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nconst [cmd, file] = process.argv.slice(2);\nif (cmd === "probe") process.exit(99);\nwriteFileSync(process.cwd() + "/" + file, "const x = 1;\\n");\n`,
		);
		chmodSync(stub, 0o755);
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
		// real face with the stub PATH: fmt rewrites ugly.ts (15 → 11 bytes)
		const before = readFileSync(target, "utf8");
		const code = runWithEnv(env, () =>
			runQltyFmt(join(repo, "src"), "ugly.ts"),
		);
		expect(code).toBe(0);
		expect(readFileSync(target, "utf8")).not.toBe(before);
		expect(readFileSync(target, "utf8")).toBe("const x = 1;\n");
	});

	test("exit 99 from a no-setup repo is reported, not swallowed", async () => {
		const world = home("probe99");
		const bin = join(world, "bin");
		mkdirSync(bin, { recursive: true });
		const stub = join(bin, "qlty");
		writeFileSync(stub, `#!/usr/bin/env bun\nprocess.exit(99);\n`);
		chmodSync(stub, 0o755);
		const code = runWithEnv(
			{ ...process.env, PATH: `${bin}:${process.env.PATH}` },
			() => runQltyFmt(world, "whatever.ts"),
		);
		expect(code).toBe(99);
	});
});

/** Run fn with an env override for PATH (spawnSync reads process.env at
 *  call time), restoring it after — no child process needed. */
function runWithEnv(env: NodeJS.ProcessEnv, fn: () => number): number {
	const saved = process.env.PATH;
	process.env.PATH = env.PATH;
	try {
		return fn();
	} finally {
		process.env.PATH = saved;
	}
}

test.describe("extension surface", () => {
	test("default export is a loadable registration function", () => {
		expect(typeof qltyOnWrite).toBe("function");
	});
});

test.describe("installPiExtensions (W3059 generalization)", () => {
	test("discovers source-syncable extensions, excludes dedicated-installer faces", () => {
		const names = piExtensionNames();
		expect(names).toContain("fleet-receiver");
		expect(names).toContain("qlty-on-write");
		// fleet-awareness ships its face via install-pi-awareness.ts (BUILT
		// index.js + fleetManaged package.json) — the generic source sync
		// must NEVER touch it (the W3059 live-face clobber regression)
		expect(names).not.toContain("fleet-awareness");
	});

	test("planned → synced → current for all extensions", () => {
		const h = home("installer");
		const dry = installPiExtensions({ home: h, dryRun: true });
		expect(dry.status).toBe("planned");
		expect(dry.results.every((r) => r.action === "planned")).toBe(true);
		const dst = join(h, ".pi/agent/extensions/qlty-on-write/index.ts");
		expect(existsSync(dst)).toBe(false);
		const s1 = installPiExtensions({ home: h });
		expect(s1.action).toBe("synced");
		expect(existsSync(dst)).toBe(true);
		const src = readFileSync(
			join(import.meta.dir, "..", "pi-extensions", "qlty-on-write", "index.ts"),
			"utf8",
		);
		expect(readFileSync(dst, "utf8")).toBe(src);
		expect(installPiExtensions({ home: h }).action).toBe("current");
	});

	test("installPiReceiver stays W2863-compatible (fleet-receiver row)", () => {
		const h = home("compat");
		const s1 = installPiReceiver({ home: h });
		expect(s1.action).toBe("synced");
		expect(s1.note).toContain("fleet-receiver");
		expect(installPiReceiver({ home: h }).action).toBe("current");
	});
});
