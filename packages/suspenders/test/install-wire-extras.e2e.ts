// test/install-wire-extras.test.ts — W918.5: the user-level wire's gate-wire
// companions resolve from the INSTALLED FACE first (prefix .harness copy) so
// the baked hook paths survive checkout deletion (the W893 worktree
// deletion broke every copilot hook on this machine). The checkout copy
// stays the fallback for prefix-less installs.
import { expect, test } from "./pw";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWireExtras, type StepContext } from "../scripts/install-run.ts";

const sentinel = (token: string): string =>
	[
		'import { appendFileSync } from "node:fs";',
		`appendFileSync(process.env.WIRE_MARKER ?? "", ${JSON.stringify(`${token}\n`)});`,
	].join("\n");

const fixture = (withPrefixFace: boolean) => {
	const home = mkdtempSync(join(tmpdir(), "wirex-home-"));
	const repo = mkdtempSync(join(tmpdir(), "wirex-repo-"));
	const prefix = mkdtempSync(join(tmpdir(), "wirex-prefix-"));
	// the adapters leg must succeed or the dialect leg never runs (early return)
	const scripts = join(repo, "scripts");
	mkdirSync(scripts, { recursive: true });
	writeFileSync(
		join(scripts, "install-policy-adapters.ts"),
		'console.log("ok");\n',
	);
	writeFileSync(join(repo, "settings.example.json"), `{"hooks": {}}\n`);
	const dialectDir = join(repo, "hooks", "dialects");
	for (const dialect of ["codex", "copilot"]) {
		const dir = join(dialectDir, dialect);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "wire.ts"), sentinel(`${dialect}:checkout`));
	}
	if (withPrefixFace) {
		const face = join(
			prefix,
			".harness",
			"packages",
			"suspenders",
			"hooks",
			"dialects",
			"copilot",
		);
		mkdirSync(face, { recursive: true });
		writeFileSync(join(face, "wire.ts"), sentinel("copilot:prefix"));
	}
	const ctx: StepContext = {
		dryRun: false,
		yes: true,
		json: false,
		verbose: false,
		repo,
		prefix,
		shimBin: join(prefix, "shims"),
		llmHome: join(prefix, "llm"),
		home,
		wireRepo: null,
	};
	return { ctx, home, repo, prefix };
};

const cleanup = (dirs: string[]): void => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
};

test.describe("runWireExtras prefix-face preference (W918.5)", () => {
	test("dialect wires run from the installed face when present", async () => {
		const { ctx, home, repo, prefix } = fixture(true);
		const marker = join(home, "marker.log");
		process.env.WIRE_MARKER = marker;
		try {
			const extras = await runWireExtras(ctx);
			expect(extras).toBe("");
			const text = readFileSync(marker, "utf8");
			expect(text).toContain("codex:checkout");
			expect(text).toContain("copilot:prefix");
		} finally {
			delete process.env.WIRE_MARKER;
			cleanup([home, repo, prefix]);
		}
	});

	test("falls back to the checkout copy when the prefix face lacks the dialect", async () => {
		const { ctx, home, repo, prefix } = fixture(false);
		const marker = join(home, "marker.log");
		process.env.WIRE_MARKER = marker;
		try {
			const extras = await runWireExtras(ctx);
			expect(extras).toBe("");
			const text = readFileSync(marker, "utf8");
			expect(text).toContain("codex:checkout");
			expect(text).toContain("copilot:checkout");
		} finally {
			delete process.env.WIRE_MARKER;
			cleanup([home, repo, prefix]);
		}
	});

	test("missing everywhere → the wire is skipped with a note", async () => {
		const { ctx, home, repo, prefix } = fixture(false);
		rmSync(join(repo, "hooks", "dialects", "copilot"), {
			recursive: true,
			force: true,
		});
		const extras = await runWireExtras(ctx);
		expect(extras).toContain("copilot gate wire missing (skipped)");
		cleanup([home, repo, prefix]);
	});
});
