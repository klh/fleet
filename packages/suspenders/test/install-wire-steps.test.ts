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
} from "../scripts/install/install-wire-steps.ts";
import type { StepContext } from "../scripts/install/install-run.ts";

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
	const oldEcosystemSkill = `---
name: klh-ecosystem-map
---
# KLH Ecosystem Map
## The five repos
Call chain for an LLM request: **surface (Claude/Copilot/VS Code) → belt
Poll your inbox at session start
`;

	function installedLegacySkill(
		root: string,
		agent: ".claude" | ".agents",
		contents = oldEcosystemSkill,
	): string {
		const dir = join(root, agent, "skills", "klh-ecosystem-map");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), contents);
		return dir;
	}

	function addSkill(root: string, name: string): void {
		const dir = join(root, "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
	}

	function stubSkillsInstall(fakeBin: string): void {
		stubExec(
			fakeBin,
			"npx",
			'#!/bin/sh\nmkdir -p "$HOME/.claude/skills/fleet"\nprintf installed > "$HOME/.claude/skills/fleet/SKILL.md"\nexit 0\n',
		);
	}

	test("no skills/ directory → skipped", async () => {
		const { ctx } = fixture();
		const res = await registerSkills(ctx);
		expect(res.status).toBe("skipped");
		expect(res.note).toContain("nothing to register");
	});

	test("skills CLI failure → failed with the manual command", async () => {
		const { root, ctx } = fixture();
		addSkill(root, "fleet");
		const fakeBin = join(root, "fakebin");
		stubExec(
			fakeBin,
			"npx",
			"#!/bin/sh\necho 'cache missing yaml/index.js' >&2\nexit 1\n",
		);
		await withPath(fakeBin, async () => {
			const res = await registerSkills(ctx);
			expect(res.status).toBe("failed");
			expect(res.note).toContain("run manually:");
			expect(res.note).toContain("npx skills add");
			expect(res.note).toContain("cache missing yaml/index.js");
		});
	});

	test("skills CLI success → ok, all packages registered", async () => {
		const { root, ctx } = fixture();
		addSkill(root, "fleet");
		const fakeBin = join(root, "fakebin");
		stubSkillsInstall(fakeBin);
		await withPath(fakeBin, async () => {
			const res = await registerSkills(ctx);
			expect(res.status).toBe("ok");
			expect(res.note).toContain("verified 1 Claude skills");
		});
		expect(
			existsSync(join(root, ".claude", "skills", "fleet", "SKILL.md")),
		).toBe(true);
	});

	test("clean install registers catalog without creating the obsolete skill", async () => {
		const { root, ctx } = fixture();
		addSkill(root, "fleet");
		const fakeBin = join(root, "fakebin");
		stubSkillsInstall(fakeBin);
		await withPath(fakeBin, async () => {
			expect((await registerSkills(ctx)).status).toBe("ok");
		});
		expect(existsSync(join(root, ".claude/skills/klh-ecosystem-map"))).toBe(
			false,
		);
		expect(existsSync(join(root, ".agents/skills/klh-ecosystem-map"))).toBe(
			false,
		);
	});

	test("upgrade retires both known obsolete copies after the current catalog is verified", async () => {
		const { root, ctx } = fixture();
		addSkill(root, "fleet");
		const claude = installedLegacySkill(root, ".claude");
		const agents = installedLegacySkill(root, ".agents");
		const fakeBin = join(root, "fakebin");
		stubSkillsInstall(fakeBin);
		await withPath(fakeBin, async () => {
			const res = await registerSkills(ctx);
			expect(res.status).toBe("ok");
			expect(res.note).toContain("retired 2 obsolete ecosystem-map copies");
		});
		expect(existsSync(claude)).toBe(false);
		expect(existsSync(agents)).toBe(false);
		expect(existsSync(join(root, ".claude/skills/fleet/SKILL.md"))).toBe(true);
	});

	test("unknown or customized skill contents remain untouched", async () => {
		const { root, ctx } = fixture();
		addSkill(root, "fleet");
		const claude = installedLegacySkill(root, ".claude", "custom skill");
		const agents = installedLegacySkill(root, ".agents");
		writeFileSync(join(agents, "README.md"), "custom supporting file");
		const fakeBin = join(root, "fakebin");
		stubSkillsInstall(fakeBin);
		await withPath(fakeBin, async () => {
			expect((await registerSkills(ctx)).status).toBe("ok");
		});
		expect(existsSync(claude)).toBe(true);
		expect(existsSync(agents)).toBe(true);
	});

	test("failed catalog registration leaves obsolete copies in place", async () => {
		const { root, ctx } = fixture();
		addSkill(root, "fleet");
		const legacy = installedLegacySkill(root, ".claude");
		const fakeBin = join(root, "fakebin");
		stubExec(fakeBin, "npx", "#!/bin/sh\nexit 1\n");
		await withPath(fakeBin, async () => {
			expect((await registerSkills(ctx)).status).toBe("failed");
		});
		expect(existsSync(legacy)).toBe(true);
	});

	test("zero-exit without installed SKILL.md → failed", async () => {
		const { root, ctx } = fixture();
		addSkill(root, "fleet");
		stubExec(join(root, "fakebin"), "npx", "#!/bin/sh\nexit 0\n");
		await withPath(join(root, "fakebin"), async () => {
			const res = await registerSkills(ctx);
			expect(res.status).toBe("failed");
			expect(res.note).toContain("Claude skills are missing");
		});
	});

	test("skills/ at the git root, ctx.repo a subdir → registers the root catalog (W903)", async () => {
		const { root, ctx } = fixture();
		// W903 repro: ctx.repo is packages/suspenders, the catalog at the root
		mkdirSync(join(root, "packages", "suspenders"), { recursive: true });
		ctx.repo = join(root, "packages", "suspenders");
		addSkill(root, "fleet");
		const run = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
		run(["init", "-q"]);
		const fakeBin = join(root, "fakebin");
		const captured = join(root, "npx-args.txt");
		stubExec(
			fakeBin,
			"npx",
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(captured)}\nmkdir -p "$HOME/.claude/skills/fleet"\nprintf installed > "$HOME/.claude/skills/fleet/SKILL.md"\nexit 0\n`,
		);
		await withPath(fakeBin, async () => {
			const res = await registerSkills(ctx);
			expect(res.status).toBe("ok");
			expect(res.note).toContain("verified 1 Claude skills");
		});
		const args = readFileSync(captured, "utf8");
		expect(args).toStartWith("skills\nadd\n");
		expect(args).toContain(join(realpathSync(root), "skills"));
		expect(args).toContain("claude-code");
	});

	test("skills runner is npx — bunx never invoked (W1044)", async () => {
		const { root, ctx } = fixture();
		addSkill(root, "fleet");
		const fakeBin = join(root, "fakebin");
		const ran = join(root, "npx-ran.txt");
		stubExec(
			fakeBin,
			"npx",
			`#!/bin/sh\nprintf npx > ${JSON.stringify(ran)}\nmkdir -p "$HOME/.claude/skills/fleet"\nprintf installed > "$HOME/.claude/skills/fleet/SKILL.md"\nexit 0\n`,
		);
		// A bunx invocation fails the step: the W1044 defect shipped the
		// register step through a bunx cache that lacked yaml/index.js.
		stubExec(fakeBin, "bunx", "#!/bin/sh\nexit 3\n");
		await withPath(fakeBin, async () => {
			const res = await registerSkills(ctx);
			expect(res.status).toBe("ok");
		});
		expect(readFileSync(ran, "utf8")).toBe("npx");
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
