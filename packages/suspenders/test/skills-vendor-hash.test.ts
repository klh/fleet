// skills-vendor-hash.test.ts — W1472: the skills vendor class gets the W292
// treatment. Two vendored surfaces, each byte-pinned to a declared manifest
// through the scripts/skills-pin.ts face (one source of truth for the hash):
// the root skills/ catalog (skills-lock.json — what `npx skills add klh/fleet`
// ships to every agent CLI) and the vendored vercel-labs/skills registry +
// license (skills-agents.pin.json). Drift fails naming the skill or file; the
// fix is to review the change, then re-pin through the face. The mutation
// probes run on tmpdir fixtures — the repo's own trees are never written here.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../scripts/skills-ci.ts";
import {
	catalogDrift,
	catalogHashes,
	LOCK,
	readVendorPin,
	REPIN,
	VENDOR_DIR,
	VENDOR_PIN,
	vendorDrift,
	writePins,
} from "../scripts/skills-pin.ts";

const AGENTS = `${VENDOR_DIR}/skills-agents.ts`;
const LICENSE = `${VENDOR_DIR}/SKILLS-LICENSE`;

function put(root: string, rel: string, text: string): void {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function seed(root: string): void {
	put(root, "skills/alpha/SKILL.md", "alpha v1\n");
	put(root, "skills/beta/SKILL.md", "beta v1\n");
	put(root, "skills/beta/references/notes.md", "beta notes v1\n");
	put(root, LOCK, `${JSON.stringify({ version: 1, skills: {} })}\n`);
	put(root, AGENTS, "export const agents = {};\n");
	put(root, LICENSE, "MIT License\n");
	put(
		root,
		`${VENDOR_DIR}/${VENDOR_PIN}`,
		JSON.stringify({
			version: 1,
			upstream: {
				repo: "vercel-labs/skills",
				npm: "skills@1.7.2",
				path: "src/agents.ts",
				license: "MIT",
			},
			files: {},
		}),
	);
	writePins(root);
}

function withFixture(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "w1472-skills-"));
	try {
		seed(root);
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("skills vendor hash parity — real trees (W1472)", () => {
	test("every skills/<name>/ tree matches its skills-lock.json pin", () => {
		expect(catalogDrift(REPO_ROOT), `review, then ${REPIN}`).toEqual([]);
	});

	test("vendored skills-agents registry + license match their manifest pins", () => {
		expect(vendorDrift(REPO_ROOT), `review, then ${REPIN}`).toEqual([]);
	});

	test("vendored registry header, license, and manifest declare one upstream", () => {
		const { upstream } = readVendorPin(REPO_ROOT);
		const header = readFileSync(join(REPO_ROOT, AGENTS), "utf8")
			.split("\n")
			.slice(0, 3)
			.join("\n");
		expect(header).toContain(
			`Source: ${upstream.repo}, ${upstream.path} @ npm ${upstream.npm}, ${upstream.license} license`,
		);
		expect(readFileSync(join(REPO_ROOT, LICENSE), "utf8")).toStartWith(
			`${upstream.license} License`,
		);
	});

	test("the pin face exits 0 on the committed trees", () => {
		const run = Bun.spawnSync(
			[
				process.execPath,
				join(REPO_ROOT, "packages/suspenders/scripts/skills-pin.ts"),
			],
			{ cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
		);
		expect(run.exitCode, run.stderr.toString()).toBe(0);
	});
});

describe("skills vendor hash parity — drift probes on fixtures (W1472)", () => {
	test("a freshly pinned fixture reports no drift", () => {
		withFixture((root) => {
			expect(catalogDrift(root)).toEqual([]);
			expect(vendorDrift(root)).toEqual([]);
		});
	});

	test("a mutated SKILL.md fails naming only that skill", () => {
		withFixture((root) => {
			put(root, "skills/alpha/SKILL.md", "alpha v2\n");
			const drift = catalogDrift(root);
			expect(drift).toHaveLength(1);
			expect(drift[0]).toStartWith("skill alpha: skills-lock.json pins ");
		});
	});

	const treeMutations: [string, (root: string) => void][] = [
		[
			"edit a nested file",
			(root) => put(root, "skills/beta/references/notes.md", "v2\n"),
		],
		[
			"add a file",
			(root) => put(root, "skills/beta/references/extra.md", "x\n"),
		],
		[
			"remove a file",
			(root) => rmSync(join(root, "skills/beta/references/notes.md")),
		],
		[
			"rename a file",
			(root) =>
				renameSync(
					join(root, "skills/beta/references/notes.md"),
					join(root, "skills/beta/references/moved.md"),
				),
		],
	];
	for (const [label, mutate] of treeMutations) {
		test(`tree mutation (${label}) fails naming only the skill`, () => {
			withFixture((root) => {
				mutate(root);
				expect(catalogDrift(root).map((line) => line.split(":")[0])).toEqual([
					"skill beta",
				]);
			});
		});
	}

	test("an unpinned new skill and a vanished pinned skill both fail by name", () => {
		withFixture((root) => {
			put(root, "skills/gamma/SKILL.md", "gamma v1\n");
			rmSync(join(root, "skills/alpha"), { recursive: true });
			const drift = catalogDrift(root).join("\n");
			expect(drift).toContain("skill gamma: not pinned in skills-lock.json");
			expect(drift).toContain("skill alpha: pinned in skills-lock.json but");
		});
	});

	test("a retargeted lock source fails naming the skill", () => {
		withFixture((root) => {
			const lock = JSON.parse(readFileSync(join(root, LOCK), "utf8"));
			lock.skills.alpha.source = "github:someone-else/skills";
			writeFileSync(join(root, LOCK), JSON.stringify(lock));
			expect(catalogDrift(root).join("\n")).toContain(
				"skill alpha: skills-lock.json declares local github:someone-else/skills",
			);
		});
	});

	test("a mutated vendored registry fails naming the file and its upstream", () => {
		withFixture((root) => {
			put(root, AGENTS, "export const agents = { tampered: true };\n");
			const drift = vendorDrift(root);
			expect(drift).toHaveLength(1);
			expect(drift[0]).toStartWith(
				"vendor skills-agents.ts (skills@1.7.2 src/agents.ts): ",
			);
		});
	});

	test("an edited license, a stray file, and a missing file each fail by name", () => {
		withFixture((root) => {
			put(root, LICENSE, "Proprietary\n");
			put(root, `${VENDOR_DIR}/stray.ts`, "export {};\n");
			rmSync(join(root, AGENTS));
			const drift = vendorDrift(root).join("\n");
			expect(drift).toContain(
				"vendor SKILLS-LICENSE (skills@1.7.2 src/agents.ts)",
			);
			expect(drift).toContain(
				"vendor stray.ts: not pinned in skills-agents.pin.json",
			);
			expect(drift).toContain(
				"vendor skills-agents.ts: pinned in skills-agents.pin.json but missing",
			);
		});
	});

	test("re-pinning is deterministic and adopts a reviewed change", () => {
		withFixture((root) => {
			const before = readFileSync(join(root, LOCK), "utf8");
			writePins(root);
			expect(readFileSync(join(root, LOCK), "utf8")).toBe(before);
			put(root, "skills/alpha/SKILL.md", "alpha v2\n");
			expect(catalogDrift(root)).not.toEqual([]);
			writePins(root);
			expect(catalogDrift(root)).toEqual([]);
		});
	});

	test("computedHash is sha256 over each file's relative path then bytes, in path order", () => {
		withFixture((root) => {
			const expected = createHash("sha256")
				.update("SKILL.md")
				.update("beta v1\n")
				.update("references/notes.md")
				.update("beta notes v1\n")
				.digest("hex");
			expect(catalogHashes(root).beta).toBe(expected);
		});
	});
});
