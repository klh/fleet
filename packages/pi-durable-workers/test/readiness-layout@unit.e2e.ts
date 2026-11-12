import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { expect, test } from "@playwright/test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stagePayload } from "../seed/stage.ts";

const packageRoot = resolve(import.meta.dir, "..");
const repository = resolve(packageRoot, "../..");
export const run = (cwd: string, args: string[]) =>
	execFileSync(process.execPath, args, {
		cwd,
		timeout: 30_000,
		killSignal: "SIGKILL",
		maxBuffer: 4 * 1024 * 1024,
		encoding: "utf8",
	});

export function withStage(body: (root: string, stage: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-readiness-layout-"));
	const stage = join(root, "stage");
	try {
		stagePayload(packageRoot, repository, stage);
		body(root, stage);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function expectReady(cwd: string, entry: string) {
	const output = run(cwd, ["--no-install", entry, Bun.version]);
	const result = JSON.parse(
		output.split("\n").find((line) => line.startsWith("{")) ?? "null",
	);
	expect(result).toMatchObject({
		ready: true,
		checks: {
			bun_pinned: true,
			extension_loads: true,
			extension_shape: true,
			registry_instantiates: true,
			git_present: true,
			tmp_writable: true,
		},
	});
	expect(output).toContain("PI_DURABLE_SEED_READY");
}

test("actual image stager preserves flattened readiness and real initialization", () => {
	withStage((_root, stage) => {
		const dockerfile = readFileSync(
			join(packageRoot, "seed/payload/Dockerfile"),
			"utf8",
		);
		expect(dockerfile).toContain("COPY src ./src");
		expect(dockerfile).toContain("COPY seed/readiness.ts ./seed/readiness.ts");
		expect(dockerfile).toContain('CMD ["bun", "run", "seed/readiness.ts"]');
		expect(readFileSync(join(stage, "seed/readiness.ts"))).toEqual(
			readFileSync(join(packageRoot, "seed/payload/readiness.ts")),
		);
		run(stage, ["install", "--offline", "--ignore-scripts", "--production"]);
		expectReady(stage, "./seed/readiness.ts");
	});
});

test("real tarball consumer resolves nested readiness through package exports", () => {
	withStage((root, _stage) => {
		const pack = join(root, "pack"),
			app = join(root, "consumer");
		mkdirSync(pack);
		mkdirSync(app);
		for (const name of ["src", "seed", "package.json"])
			cpSync(join(packageRoot, name), join(pack, name), { recursive: true });
		run(pack, ["pm", "pack", "--ignore-scripts"]);
		const tarballs = readdirSync(pack).filter((name) => name.endsWith(".tgz"));
		expect(tarballs).toHaveLength(1);
		writeFileSync(
			join(app, "package.json"),
			JSON.stringify({
				name: "readiness-consumer-fixture",
				private: true,
				dependencies: {
					"@klh/pi-durable-workers": `file:../pack/${tarballs[0]}`,
				},
				overrides: { "@klh/buckle": "file:../stage/vendor/@klh/buckle" },
			}),
		);
		run(app, ["install", "--offline", "--ignore-scripts", "--production"]);
		expectReady(
			app,
			"./node_modules/@klh/pi-durable-workers/seed/payload/readiness.ts",
		);
	});
});
