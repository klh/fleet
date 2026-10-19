// test/install-wire-steps.test.ts — W771.3: the native registerCaddy /
// registerSkills / releaseNotify steps. The W549 truthfulness and the W631
// posture guard move here from the retired install.sh caddy block; the bash
// block extraction tests retired with the block.
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	registerCaddy,
	registerSkills,
	releaseNotify,
} from "../scripts/install-wire-steps.ts";
import type { StepContext } from "../scripts/install-run.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fixture(): { root: string; ctx: StepContext } {
	const root = mkdtempSync(join(tmpdir(), "fleet-wire-steps-"));
	dirs.push(root);
	const ctx: StepContext = {
		repo: root,
		prefix: join(root, "prefix"),
		shimBin: join(root, "bin"),
		llmHome: join(root, "llm"),
		home: root,
		dryRun: false,
		yes: true,
		json: true,
		verbose: false,
	};
	return { root, ctx };
}

function stubExec(dir: string, name: string, body: string): void {
	mkdirSync(dir, { recursive: true });
	const script = join(dir, name);
	writeFileSync(script, body);
	chmodSync(script, 0o755);
}

async function withPath(fakeBin: string, fn: () => Promise<void>) {
	const old = process.env.PATH;
	process.env.PATH = `${fakeBin}:${old ?? ""}`;
	try {
		await fn();
	} finally {
		process.env.PATH = old;
	}
}

describe("registerCaddy (W549 truthful outcome, native)", () => {
	test("tools absent → skipped, nothing attempted", async () => {
		const { ctx } = fixture();
		const res = await registerCaddy(ctx);
		expect(res.status).toBe("skipped");
		expect(res.note).toContain("not attempted");
	});

	test("stale klh-local (no W602 posture) → failed BEFORE any register", async () => {
		const { root, ctx } = fixture();
		const homeBin = join(root, ".local/bin");
		stubExec(
			homeBin,
			"klh-local",
			'#!/bin/sh\nprintf attempted > "$HOME/reg-proof"\nexit 0\n',
		);
		const fakeBin = join(root, "fakebin");
		stubExec(fakeBin, "caddy", "#!/bin/sh\nexit 0\n");
		await withPath(fakeBin, async () => {
			const res = await registerCaddy(ctx);
			expect(res.status).toBe("failed");
			expect(res.note).toContain("predates W602");
		});
		expect(existsSync(join(root, "reg-proof"))).toBe(false);
	});
});

describe("registerCaddy register paths", () => {
	test("fresh klh-local + register ok → ok", async () => {
		const { root, ctx } = fixture();
		stubExec(
			join(root, ".local/bin"),
			"klh-local",
			`#!/bin/sh\n# abort @external\nprintf registered > ${JSON.stringify(join(root, "reg-proof"))}\nexit 0\n`,
		);
		const fakeBin = join(root, "fakebin");
		stubExec(fakeBin, "caddy", "#!/bin/sh\nexit 0\n");
		await withPath(fakeBin, async () => {
			const res = await registerCaddy(ctx);
			expect(res.status).toBe("ok");
			expect(res.note).toContain("registered with klh-local/Caddy");
		});
		expect(existsSync(join(root, "reg-proof"))).toBe(true);
	});

	test("register failure → truthful failed row, loopback fallback named", async () => {
		const { root, ctx } = fixture();
		stubExec(
			join(root, ".local/bin"),
			"klh-local",
			"#!/bin/sh\n# abort @external\nexit 1\n",
		);
		const fakeBin = join(root, "fakebin");
		stubExec(fakeBin, "caddy", "#!/bin/sh\nexit 0\n");
		await withPath(fakeBin, async () => {
			const res = await registerCaddy(ctx);
			expect(res.status).toBe("failed");
			expect(res.note).toContain("127.0.0.1:7799");
		});
	});
});

describe("registerSkills", () => {
	test("no skills/ directory → skipped", async () => {
		const { ctx } = fixture();
		const res = await registerSkills(ctx);
		expect(res.status).toBe("skipped");
		expect(res.note).toContain("nothing to register");
	});

	test("skills CLI failure → failed with the manual command", async () => {
		const { root, ctx } = fixture();
		mkdirSync(join(root, "skills"), { recursive: true });
		const fakeBin = join(root, "fakebin");
		stubExec(fakeBin, "bunx", "#!/bin/sh\nexit 1\n");
		await withPath(fakeBin, async () => {
			const res = await registerSkills(ctx);
			expect(res.status).toBe("failed");
			expect(res.note).toContain("run manually:");
		});
	});

	test("skills CLI success → ok, all packages registered", async () => {
		const { root, ctx } = fixture();
		mkdirSync(join(root, "skills"), { recursive: true });
		const fakeBin = join(root, "fakebin");
		stubExec(fakeBin, "bunx", '#!/bin/sh\necho "Found 10"\nexit 0\n');
		await withPath(fakeBin, async () => {
			const res = await registerSkills(ctx);
			expect(res.status).toBe("ok");
			expect(res.note).toContain("registered all packages");
		});
	});

	test("skills/ at the git root, ctx.repo a subdir → registers the root catalog (W903)", async () => {
		const { root, ctx } = fixture();
		// W903 repro: ctx.repo is packages/suspenders, the catalog at the root
		mkdirSync(join(root, "packages", "suspenders"), { recursive: true });
		ctx.repo = join(root, "packages", "suspenders");
		mkdirSync(join(root, "skills"), { recursive: true });
		const run = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
		run(["init", "-q"]);
		const fakeBin = join(root, "fakebin");
		const captured = join(root, "bunx-args.txt");
		stubExec(
			fakeBin,
			"bunx",
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(captured)}\nexit 0\n`,
		);
		await withPath(fakeBin, async () => {
			const res = await registerSkills(ctx);
			expect(res.status).toBe("ok");
			expect(res.note).toContain("registered all packages");
		});
		const args = readFileSync(captured, "utf8");
		expect(args).toContain(join(realpathSync(root), "skills"));
		expect(args).toContain("claude-code");
	});
});

describe("releaseNotify", () => {
	test("coord absent at the prefix → skipped (fresh machine)", async () => {
		const { ctx } = fixture();
		const res = await releaseNotify(ctx);
		expect(res.status).toBe("skipped");
		expect(res.note).toContain("fresh machine");
	});

	test("untagged repo → emits version unknown, note deployed", async () => {
		const { root, ctx } = fixture();
		const captured = join(root, "coord-args.txt");
		stubExec(
			join(ctx.prefix, "bin"),
			"coord.ts",
			`#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(captured)}, Bun.argv.join("\\n"));\n`,
		);
		const res = await releaseNotify(ctx);
		expect(res.status).toBe("ok");
		const args = readFileSync(captured, "utf8");
		expect(args).toContain("unknown");
		expect(args).toContain("deployed");
	});

	test("tagged repo + working coord → ok, RELEASE announced as installer", async () => {
		const { root, ctx } = fixture();
		const captured = join(root, "coord-args.txt");
		stubExec(
			join(ctx.prefix, "bin"),
			"coord.ts",
			`#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(captured)}, Bun.argv.join("\\n"));\n`,
		);
		const run = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
		run(["init", "-q"]);
		run(["config", "user.email", "t@fixture"]);
		run(["config", "user.name", "t"]);
		writeFileSync(join(root, "f.txt"), "x");
		run(["add", "."]);
		run(["commit", "-qm", "c1"]);
		run(["tag", "-a", "v9.9.9", "-m", "fixture release note"]);
		const res = await releaseNotify(ctx);
		expect(res.status).toBe("ok");
		expect(res.note).toContain("RELEASE v9.9.9");
		const args = readFileSync(captured, "utf8");
		expect(args).toContain("installer");
		expect(args).toContain("fixture release note");
	});

	test("emit failure → truthful failed row, non-fatal wording", async () => {
		const { ctx } = fixture();
		stubExec(
			join(ctx.prefix, "bin"),
			"coord.ts",
			"#!/usr/bin/env bun\nprocess.exit(1);\n",
		);
		const res = await releaseNotify(ctx);
		expect(res.status).toBe("failed");
		expect(res.note).toContain("non-fatal");
	});
});
