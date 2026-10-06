import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fleet-format-"));
const bin = join(root, "bin");
mkdirSync(bin);
// Exercise the real hook subprocess and verdict plumbing, without downloading
// plugins or sharing governor state. The stub separates formatting from lint.
const qlty = join(bin, "qlty");
writeFileSync(
	qlty,
	`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = args.at(-1);
fs.appendFileSync(process.env.FORMAT_CALLS, JSON.stringify(args) + "\\n");
const source = fs.readFileSync(file, "utf8");
if (args[0] === "fmt") fs.writeFileSync(file, source.replace("export const x=1", "export const x = 1;"));
else if (source.includes("LINT_FAILURE")) { console.error("substantive lint failure"); process.exit(1); }
else if (!args.includes("--no-formatters") && source.includes("export const x=1")) { console.error("format mismatch"); process.exit(1); }
`,
);
chmodSync(qlty, 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;

function fixture(source: string, lane?: string) {
	const repo = join(root, `repo-${++sequence}`);
	mkdirSync(repo);
	const dir = lane ? join(repo, lane, "lane") : repo;
	mkdirSync(dir, { recursive: true });
	Bun.spawnSync(["git", "init", "-q", dir]);
	const file = join(dir, "source.ts");
	writeFileSync(file, source);
	// Track nested files so git status enumerates the file instead of its folder.
	Bun.spawnSync(["git", "-C", dir, "add", file]);
	return { repo: dir, file, calls: join(root, `calls-${sequence}.ndjson`) };
}

function gate(event: string, f: ReturnType<typeof fixture>) {
	const input = join(root, `input-${sequence}.json`);
	writeFileSync(
		input,
		JSON.stringify({
			cwd: f.repo,
			tool_name: "Write",
			tool_input: { file_path: f.file },
		}),
	);
	const result = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../hooks/gate.ts"), event],
		{
			stdin: Bun.file(input),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: f.repo,
				PATH: `${bin}:${process.env.PATH}`,
				FORMAT_CALLS: f.calls,
			},
		},
	);
	return {
		code: result.exitCode,
		out: result.stdout.toString(),
		err: result.stderr.toString(),
	};
}

describe("formatting is normalization, not an unresolved failure", () => {
	test("post-save reports a successful rewrite as context with exit zero", () => {
		const f = fixture("export const x=1\n");
		const result = gate("post-files", f);
		expect(result.code).toBe(0);
		expect(result.err).toBe("");
		expect(
			JSON.parse(result.out).hookSpecificOutput.additionalContext,
		).toContain("auto-fixed");
		expect(readFileSync(f.file, "utf8")).toBe("export const x = 1;\n");
	});
	test("stop accepts newly formatted code after a clean quality check", () => {
		const f = fixture("export const x=1\n");
		expect(gate("stop", f).code).toBe(0);
		expect(readFileSync(f.file, "utf8")).toBe("export const x = 1;\n");
		expect(readFileSync(f.calls, "utf8")).toContain('"check"');
	});
	test("stop still blocks a substantive failure after formatting", () => {
		const result = gate("stop", fixture("export const x=1\n// LINT_FAILURE\n"));
		expect(result.code).toBe(2);
		expect(result.err).toContain("substantive lint failure");
	});
	test("formatter corrections cannot bypass the size guard", () => {
		const result = gate(
			"post-files",
			fixture(`export const x=1\n${"// line\n".repeat(1501)}`),
		);
		expect(result.code).toBe(2);
		expect(result.err).toContain("1500-LINE LIMIT");
	});
	for (const lane of [".worktrees", ".claude/worktrees"]) {
		test(`${lane} defers cosmetic checks until stop`, () => {
			const f = fixture("export const x=1\n", lane);
			expect(gate("post-files", f).code).toBe(0);
			expect(readFileSync(f.file, "utf8")).toContain("x=1");
			expect(readFileSync(f.calls, "utf8")).toContain("--no-formatters");
			expect(gate("stop", f).code).toBe(0);
			expect(readFileSync(f.file, "utf8")).toContain("x = 1;");
		});
	}
	test("deferred lanes still receive substantive lint failures immediately", () => {
		const result = gate(
			"post-files",
			fixture("// LINT_FAILURE\n", ".worktrees"),
		);
		expect(result.code).toBe(2);
		expect(result.err).toContain("substantive lint failure");
	});
});
