import { missingImportsExplained } from "./coverage-proof.ts";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { hostProcess } from "../../../deploy/host/process.ts";
import { coverageProofManifest, shareNodeModules } from "./coverage-proof.ts";
import {
	type CoverageRunInput,
	runCoverageGroups,
} from "./coverage-proof-runner.ts";

function fixture() {
	const world = scratchWorld({ prefix: "mixed-proof-" });
	const put = (path: string, source: string) => {
		const file = join(world.repo, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, source);
	};
	shareNodeModules(resolve(import.meta.dir, "../../../../.."), world.repo, []);
	put("source.ts", "export const value = 0;");
	put(
		"legacy.test.ts",
		'import {test,expect} from "bun:test"; test("legacy unrelated check",()=>expect(1).toBe(1));',
	);
	put("packages/demo/test/helper.fixtures.ts", "export const expected = 1;");
	put(
		"packages/demo/test/proof@unit.e2e.ts",
		'import {test,expect} from "@playwright/test"; import {value} from "../../../source.ts"; import {expected} from "./helper.fixtures.ts"; test("regression",()=>expect(value).toBe(expected));',
	);
	put(
		"packages/demo/test/playwright.config.ts",
		'export default {testDir:".",testMatch:"**/*.e2e.ts"};',
	);
	const input: CoverageRunInput = {
		cwd: world.repo,
		outputDir: join(world.home, "output"),
		timeoutMs: 15_000,
		groups: [
			{ runner: "bun", files: ["legacy.test.ts"] },
			{
				runner: "playwright",
				config: "packages/demo/test/playwright.config.ts",
				files: ["packages/demo/test/proof@unit.e2e.ts"],
			},
		],
		unsupported: [],
		addedProd: [],
		testFiles: [
			"legacy.test.ts",
			"packages/demo/test/proof@unit.e2e.ts",
			"packages/demo/test/helper.fixtures.ts",
		],
		addedWorkspaceDeps: [],
		purePort: false,
	};
	return { ...world, put, input };
}

test("mixed unrelated Bun pass plus actual Playwright baseline RED proves the change", async () => {
	const f = fixture();
	try {
		const result = await runCoverageGroups(f.input);
		expect(result.status).toBe("proved");
		expect(result.failed, result.detail).toBe(1);
		expect(result.passed).toBe(1);
		expect(result.detail).toContain("playwright");
		expect(existsSync(join(f.repo, "test-results"))).toBe(false);
	} finally {
		f.clean();
	}
});

test("all selected Bun and Playwright tests really passing retains no-coverage", async () => {
	const f = fixture();
	try {
		f.put("source.ts", "export const value = 1;");
		const result = await runCoverageGroups(f.input);
		expect(result.status).toBe("no-coverage");
		expect(result.passed).toBe(2);
		expect(result.failed).toBe(0);
	} finally {
		f.clean();
	}
});

test("unsupported specs remain unknown even with a passing supported suite", async () => {
	const f = fixture();
	try {
		const result = await runCoverageGroups({
			...f.input,
			groups: [f.input.groups[0]],
			unsupported: ["other.e2e.ts"],
		});
		expect(result.status).toBe("unknown");
		expect(result.detail).toContain("other.e2e.ts");
	} finally {
		f.clean();
	}
});

test("an actual skipped Playwright regression cannot claim complete coverage", async () => {
	const f = fixture();
	try {
		f.put(
			"packages/demo/test/proof@unit.e2e.ts",
			'import {test} from "@playwright/test"; test.skip("not run",()=>{});',
		);
		const result = await runCoverageGroups(f.input);
		expect(result.status).toBe("unknown");
		expect(result.detail).toContain("skipped");
	} finally {
		f.clean();
	}
});

test("a config silently omitting a selected spec cannot claim all tests passed", async () => {
	const f = fixture();
	try {
		f.put("source.ts", "export const value = 1;");
		f.put(
			"packages/demo/test/omitted.e2e.ts",
			'import {test,expect} from "@playwright/test"; test("must run",()=>expect(0).toBe(1));',
		);
		f.put(
			"packages/demo/test/playwright.config.ts",
			'export default {testDir:".",testMatch:"**/proof@unit.e2e.ts"};',
		);
		const groups = [
			f.input.groups[0],
			{
				runner: "playwright" as const,
				config: "packages/demo/test/playwright.config.ts",
				files: [
					"packages/demo/test/proof@unit.e2e.ts",
					"packages/demo/test/omitted.e2e.ts",
				],
			},
		];
		const result = await runCoverageGroups({ ...f.input, groups });
		expect(result.status).toBe("unknown");
		expect(result.detail).toContain("omitted.e2e.ts");
	} finally {
		f.clean();
	}
});

test("timeout joins an inherited writer and never banks proof", async () => {
	const f = fixture();
	try {
		const marker = join(f.home, "orphan-marker");
		const startedMarker = join(f.home, "writer-started");
		const writer = [
			"await Bun.write(",
			JSON.stringify(startedMarker),
			', "started"); await Bun.sleep(1200); await Bun.write(',
			JSON.stringify(marker),
			', "orphan");',
		].join("");
		f.put(
			"legacy.test.ts",
			[
				'import {test} from "bun:test"; test("wait",async()=>{Bun.spawn([process.execPath,"-e",',
				JSON.stringify(writer),
				'],{stdout:"inherit",stderr:"inherit"});await Bun.sleep(1500);});',
			].join(""),
		);
		const started = performance.now();
		const result = await runCoverageGroups({
			...f.input,
			groups: [f.input.groups[0]],
			timeoutMs: 500,
		});
		expect(result.status).toBe("error");
		expect(performance.now() - started).toBeLessThan(2000);
		expect(existsSync(startedMarker)).toBe(true);
		await Bun.sleep(1300);
		expect(existsSync(marker)).toBe(false);
	} finally {
		f.clean();
	}
});

function report(root: string, overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		config: { rootDir: root },
		suites: overrides.stats
			? []
			: [
					{
						specs: [
							{
								file: "packages/demo/test/proof@unit.e2e.ts",
								tests: [{ status: "expected" }],
							},
						],
					},
				],
		errors: [],
		stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
		...overrides,
	});
}

for (const [name, stdout, expected] of [
	["malformed JSON", "not json", "error"],
	["zero collected tests", "zero", "unknown"],
] as const) {
	test(name, async () => {
		const f = fixture();
		try {
			const output =
				stdout === "zero"
					? report(f.repo, {
							stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 },
						})
					: stdout;
			const result = await runCoverageGroups(
				{ ...f.input, groups: [f.input.groups[1]] },
				{
					run: async () => ({
						code: 0,
						signal: null,
						stdout: Buffer.from(output),
						stderr: Buffer.alloc(0),
					}),
				},
			);
			expect(result.status).toBe(expected);
		} finally {
			f.clean();
		}
	});
}

for (const explained of [true, false]) {
	test(
		explained
			? "exact diff-added missing import proves the change"
			: "unrelated missing import remains environmental",
		async () => {
			const f = fixture();
			try {
				const message = [
					"Cannot find module '../../../new.ts' from '",
					f.repo,
					"/packages/demo/test/proof@unit.e2e.ts'",
				].join("");
				const output = report(f.repo, {
					errors: [{ message }],
					stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 },
				});
				const result = await runCoverageGroups(
					{
						...f.input,
						groups: [f.input.groups[1]],
						addedProd: explained ? ["new.ts"] : [],
					},
					{
						run: async () => ({
							code: 1,
							signal: null,
							stdout: Buffer.from(output),
							stderr: Buffer.alloc(0),
						}),
					},
				);
				expect(result.status).toBe(explained ? "proved" : "error");
			} finally {
				f.clean();
			}
		},
	);
}

test("runner pins config, one worker, byte cap and shared remaining deadline", async () => {
	const f = fixture();
	try {
		const calls: {
			argv: readonly string[];
			timeoutMs: number;
			maxBytes?: number;
		}[] = [];
		const result = await runCoverageGroups(f.input, {
			run: async (argv, options) => {
				calls.push({
					argv,
					timeoutMs: options.timeoutMs,
					maxBytes: options.maxBytes,
				});
				await Bun.sleep(10);
				return {
					code: 0,
					signal: null,
					stdout: Buffer.from(
						argv.includes("--reporter=json")
							? report(f.repo)
							: "1 pass\n0 fail\n",
					),
					stderr: Buffer.alloc(0),
				};
			},
		});
		expect(result.status).toBe("no-coverage");
		expect(calls[1].argv).toContain("packages/demo/test/playwright.config.ts");
		expect(calls[1].argv).toContain("--workers=1");
		expect(calls.every((call) => call.argv[1] === "--no-install")).toBe(true);
		expect(calls[1].timeoutMs).toBeLessThan(calls[0].timeoutMs);
		expect(calls.every((call) => call.maxBytes === 8 * 1024 * 1024)).toBe(true);
	} finally {
		f.clean();
	}
});

test("workspace aliases read reversed scratch production for root and sibling imports", async () => {
	const candidate = scratchWorld({ prefix: "proof-candidate-" });
	const baseline = scratchWorld({ prefix: "proof-baseline-" });
	const put = (root: string, path: string, text: string) => {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	try {
		for (const world of [candidate, baseline]) {
			put(
				world.repo,
				"packages/shared/package.json",
				JSON.stringify({
					name: "@example/shared",
					type: "module",
					exports: "./index.ts",
				}),
			);
			put(
				world.repo,
				"packages/demo/package.json",
				JSON.stringify({ name: "custom-demo", type: "module" }),
			);
			put(
				world.repo,
				"read.ts",
				'import {value} from "@example/shared"; process.stdout.write(String(value));',
			);
			put(
				world.repo,
				"packages/demo/read.ts",
				'import {value} from "@example/shared"; process.stdout.write(String(value));',
			);
		}
		put(candidate.repo, "packages/shared/index.ts", "export const value = 2;");
		put(baseline.repo, "packages/shared/index.ts", "export const value = 1;");
		for (const directory of [
			"node_modules/@example",
			"packages/demo/node_modules/@example",
		]) {
			mkdirSync(join(candidate.repo, directory), { recursive: true });
			symlinkSync(
				join(candidate.repo, "packages/shared"),
				join(candidate.repo, directory, "shared"),
			);
		}
		shareNodeModules(candidate.repo, baseline.repo, [
			"packages/demo/package.json",
		]);
		expect(
			realpathSync(join(baseline.repo, "node_modules/@example/shared")),
		).toBe(realpathSync(join(baseline.repo, "packages/shared")));
		for (const path of ["read.ts", "packages/demo/read.ts"]) {
			const result = await hostProcess(
				[process.execPath, join(baseline.repo, path)],
				{ cwd: baseline.repo, timeoutMs: 5000 },
			);
			expect(result.code).toBe(0);
			expect(new TextDecoder().decode(result.stdout).trim()).toBe("1");
		}
		expect(
			realpathSync(join(candidate.repo, "node_modules/@example/shared")),
		).toBe(realpathSync(join(candidate.repo, "packages/shared")));
	} finally {
		baseline.clean();
		candidate.clean();
	}
});

test("real Git reversal restores every changed fixture and executes the exact package config", async () => {
	const f = fixture();
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(
			[
				"git",
				"--no-replace-objects",
				"-c",
				"core.hooksPath=/dev/null",
				...args,
			],
			{
				cwd: f.repo,
				env: f.env,
				timeout: 5000,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		return result.stdout.toString().trim();
	};
	try {
		f.put(".gitignore", "node_modules\n");
		f.put(
			"packages/demo/test/helper.fixtures.ts",
			"export const expected = 0;",
		);
		git("add", "-A");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"baseline",
		);
		const base = git("rev-parse", "HEAD");
		f.put("source.ts", "export const value = 1;");
		f.put(
			"packages/demo/test/helper.fixtures.ts",
			"export const expected = 1;",
		);
		f.put(
			"packages/demo/test/new_test_proof@unit.e2e.ts",
			'import {test,expect} from "@playwright/test"; import {value} from "../../../source.ts"; import {expected} from "./helper.fixtures.ts"; test("new regression",()=>expect(value).toBe(expected));',
		);
		f.put(
			"new.test.ts",
			'import {test,expect} from "bun:test"; test("unrelated",()=>expect(1).toBe(1));',
		);
		git("add", "-A");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"candidate",
		);
		const tip = git("rev-parse", "HEAD");
		const manifest = coverageProofManifest(base, tip, (args) => {
			const result = Bun.spawnSync(["git", ...args], {
				cwd: f.repo,
				env: f.env,
				timeout: 5000,
				stdout: "pipe",
				stderr: "pipe",
			});
			return { code: result.exitCode, out: result.stdout.toString() };
		});
		expect(manifest.unsupported).toEqual([]);
		expect(manifest.runnerGroups).toEqual([
			{ runner: "bun", files: ["new.test.ts"] },
			{
				runner: "playwright",
				config: "packages/demo/test/playwright.config.ts",
				files: ["packages/demo/test/new_test_proof@unit.e2e.ts"],
			},
		]);
		expect(manifest.testFiles).toContain(
			"packages/demo/test/helper.fixtures.ts",
		);
		// The production branch is green before reversing, proving this is a regression.
		const positive = await runCoverageGroups({
			...f.input,
			groups: manifest.runnerGroups,
			testFiles: manifest.testFiles,
		});
		expect(positive.status).toBe("no-coverage");
		const patch = git("diff", manifest.range);
		const reverse = Bun.spawnSync(["git", "apply", "-R"], {
			cwd: f.repo,
			env: f.env,
			stdin: Buffer.from(`${patch}\n`),
			timeout: 5000,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(reverse.exitCode, reverse.stderr.toString()).toBe(0);
		git("checkout", tip, "--", ...manifest.testFiles);
		expect(readFileSync(join(f.repo, "source.ts"), "utf8")).toBe(
			"export const value = 0;",
		);
		expect(
			readFileSync(
				join(f.repo, "packages/demo/test/helper.fixtures.ts"),
				"utf8",
			),
		).toBe("export const expected = 1;");
		const result = await runCoverageGroups({
			...f.input,
			groups: manifest.runnerGroups,
			testFiles: manifest.testFiles,
		});
		expect(result.status).toBe("proved");
		expect(result.failed, result.detail).toBe(1);
		expect(result.passed).toBe(1);
	} finally {
		f.clean();
	}
});

test("Playwright absolute selectors preserve literal metacharacters and do not run other specs", async () => {
	const f = fixture();
	try {
		const file = "packages/demo/test/only[one] #.e2e.ts";
		f.put(
			file,
			'import {test,expect} from "@playwright/test"; test("selected",()=>expect(0).toBe(1));',
		);
		const result = await runCoverageGroups({
			...f.input,
			groups: [
				{
					runner: "playwright",
					config: "packages/demo/test/playwright.config.ts",
					files: [file],
				},
			],
		});
		expect(result.status, result.detail).toBe("proved");
		expect(result.failed, result.detail).toBe(1);
	} finally {
		f.clean();
	}
});

test("Bun todo alongside a passing test remains incomplete", async () => {
	const f = fixture();
	try {
		f.put(
			"legacy.test.ts",
			'import {test,expect} from "bun:test";test("pass",()=>expect(1).toBe(1));test.todo("pending");',
		);
		const result = await runCoverageGroups({
			...f.input,
			groups: [f.input.groups[0]],
		});
		expect(result.status).toBe("unknown");
	} finally {
		f.clean();
	}
});

test("unselected files in a structured report are explicit incomplete execution", async () => {
	const f = fixture();
	try {
		const output = report(f.repo, {
			stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0 },
			suites: [
				{
					specs: [
						{
							file: "packages/demo/test/proof@unit.e2e.ts",
							tests: [{ status: "expected" }],
						},
						{
							file: "packages/demo/test/unselected.e2e.ts",
							tests: [{ status: "expected" }],
						},
					],
				},
			],
		});
		const result = await runCoverageGroups(
			{ ...f.input, groups: [f.input.groups[1]] },
			{
				run: async () => ({
					code: 0,
					signal: null,
					stdout: Buffer.from(output),
					stderr: Buffer.alloc(0),
				}),
			},
		);
		expect(result.status).toBe("unknown");
		expect(result.detail).toContain("unexpected collected spec");
	} finally {
		f.clean();
	}
});

for (const explained of [false, true]) {
	test(
		explained
			? "runtime dynamic import of exact diff-added source proves change"
			: "unrelated runtime dynamic import cannot prove a production change",
		async () => {
			const f = fixture();
			try {
				const expression = explained
					? '["../../../", "new-source.ts"].join("")'
					: '["not", "installed", "fixture"].join("-")';
				f.put(
					"packages/demo/test/proof@unit.e2e.ts",
					[
						'import {test} from "@playwright/test";test("runtime import",async()=>{const name=',
						expression,
						";await import(name);});",
					].join(""),
				);
				const result = await runCoverageGroups({
					...f.input,
					groups: [f.input.groups[1]],
					addedProd: explained ? ["new-source.ts"] : [],
				});
				expect(result.status, result.detail).toBe(
					explained ? "proved" : "error",
				);
			} finally {
				f.clean();
			}
		},
	);
}

test("workspace bin files execute baseline bytes while external cached bins remain external", async () => {
	const candidate = scratchWorld({ prefix: "bin-candidate-" });
	const baseline = scratchWorld({ prefix: "bin-baseline-" });
	const put = (root: string, path: string, text: string) => {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	try {
		for (const world of [candidate, baseline]) {
			put(
				world.repo,
				"packages/tool/package.json",
				JSON.stringify({ name: "@example/tool", type: "module" }),
			);
			put(
				world.repo,
				"packages/consumer/package.json",
				JSON.stringify({ name: "custom-consumer", type: "module" }),
			);
		}
		put(candidate.repo, "packages/tool/cli.ts", 'process.stdout.write("2");');
		put(baseline.repo, "packages/tool/cli.ts", 'process.stdout.write("1");');
		put(candidate.home, "cached-compiler.ts", 'process.stdout.write("3");');
		for (const directory of [
			"node_modules/.bin",
			"packages/consumer/node_modules/.bin",
		]) {
			mkdirSync(join(candidate.repo, directory), { recursive: true });
			symlinkSync(
				join(candidate.repo, "packages/tool/cli.ts"),
				join(candidate.repo, directory, "fixture-tool"),
			);
			symlinkSync(
				join(candidate.home, "cached-compiler.ts"),
				join(candidate.repo, directory, "cached-compiler"),
			);
		}
		shareNodeModules(candidate.repo, baseline.repo, [
			"packages/consumer/package.json",
		]);
		for (const directory of [
			"node_modules/.bin",
			"packages/consumer/node_modules/.bin",
		]) {
			const run = await hostProcess(
				[process.execPath, join(baseline.repo, directory, "fixture-tool")],
				{ cwd: baseline.repo, timeoutMs: 5000 },
			);
			expect(run.code).toBe(0);
			expect(new TextDecoder().decode(run.stdout)).toBe("1");
			const external = await hostProcess(
				[process.execPath, join(baseline.repo, directory, "cached-compiler")],
				{ cwd: baseline.repo, timeoutMs: 5000 },
			);
			expect(external.code).toBe(0);
			expect(new TextDecoder().decode(external.stdout)).toBe("3");
			expect(
				realpathSync(join(baseline.repo, directory, "cached-compiler")),
			).toBe(realpathSync(join(candidate.home, "cached-compiler.ts")));
		}
		expect(
			realpathSync(join(candidate.repo, "node_modules/.bin/fixture-tool")),
		).toBe(realpathSync(join(candidate.repo, "packages/tool/cli.ts")));
	} finally {
		baseline.clean();
		candidate.clean();
	}
});

for (const explained of [false, true]) {
	test(
		explained
			? "result errors array preserves exact diff-added import evidence"
			: "result errors array cannot hide an unrelated missing import",
		async () => {
			const f = fixture();
			try {
				const message = [
					"ResolveMessage: Cannot find module '../../../new-source.ts' imported from ",
					f.repo,
					"/packages/demo/test/proof@unit.e2e.ts",
				].join("");
				const output = report(f.repo, {
					stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0 },
					suites: [
						{
							specs: [
								{
									file: "packages/demo/test/proof@unit.e2e.ts",
									tests: [
										{
											status: "unexpected",
											results: [{ errors: [{ stack: message }] }],
										},
									],
								},
							],
						},
					],
				});
				const result = await runCoverageGroups(
					{
						...f.input,
						groups: [f.input.groups[1]],
						addedProd: explained ? ["new-source.ts"] : [],
					},
					{
						run: async () => ({
							code: 1,
							signal: null,
							stdout: Buffer.from(output),
							stderr: Buffer.alloc(0),
						}),
					},
				);
				expect(result.status).toBe(explained ? "proved" : "error");
			} finally {
				f.clean();
			}
		},
	);
}

for (const mode of ["runtime-missing", "passed", "skipped"] as const) {
	test(
		["explained global teardown also validates test result: ", mode].join(""),
		async () => {
			const f = fixture();
			try {
				f.put(
					"packages/demo/test/playwright.config.ts",
					'export default {testDir:".",testMatch:"**/*.e2e.ts",globalTeardown:"./teardown.ts"};',
				);
				f.put(
					"packages/demo/test/teardown.ts",
					'export default async()=>{const name=["../","new-source.ts"].join("");await import(name);};',
				);
				const body =
					mode === "runtime-missing"
						? 'test("runtime",async()=>{const name=["not","installed","fixture"].join("-");await import(name);});'
						: mode === "skipped"
							? 'test.skip("skipped",()=>{});'
							: 'test("passed",()=>{});';
				f.put(
					"packages/demo/test/proof@unit.e2e.ts",
					['import {test} from "@playwright/test";', body].join(""),
				);
				const result = await runCoverageGroups({
					...f.input,
					groups: [f.input.groups[1]],
					addedProd: ["packages/demo/new-source.ts"],
					testFiles: [...f.input.testFiles, "packages/demo/test/teardown.ts"],
				});
				expect(result.status, result.detail).toBe(
					mode === "runtime-missing"
						? "error"
						: mode === "skipped"
							? "unknown"
							: "proved",
				);
				if (mode === "passed") expect(result.passed).toBe(1);
			} finally {
				f.clean();
			}
		},
	);
}

test("provided scratch binds imports and targets exactly, including real/private aliases", () => {
	const f = fixture();
	try {
		const importer = join(f.repo, "packages/demo/test/proof@unit.e2e.ts");
		const check = (
			spec: string,
			from: string,
			added: string[],
			expected: boolean,
			label: string,
		) => {
			const output = [
				"error: Cannot find module '",
				spec,
				"' from '",
				from,
				"'",
			].join("");
			expect(
				missingImportsExplained(output, added, f.input.testFiles, [], f.repo),
				label,
			).toBe(expected);
		};
		check(
			"../../../new-source.ts",
			importer,
			["new-source.ts"],
			true,
			"internal relative",
		);
		check(
			join(f.repo, "new-source.ts"),
			importer,
			["new-source.ts"],
			true,
			"internal absolute",
		);
		check(
			join(f.home, "new-source.ts"),
			importer,
			["new-source.ts"],
			false,
			"outside target with same suffix",
		);
		check(
			"../../../new-source.ts",
			join(f.home, "packages/demo/test/proof@unit.e2e.ts"),
			["new-source.ts"],
			false,
			"outside importer with same suffix",
		);
		check(
			"../../../../outside/new-source.ts",
			importer,
			["new-source.ts"],
			false,
			"relative escape",
		);
		check(
			"new-source",
			importer,
			["packages/demo/test/new-source.ts"],
			false,
			"bare package is not a relative source file",
		);
		check(
			["/private", f.repo, "/new-source.ts"].join(""),
			["/private", importer].join(""),
			["new-source.ts"],
			true,
			"private path alias",
		);
		symlinkSync(f.home, join(f.repo, "linked"));
		check(
			join(f.repo, "linked/new-source.ts"),
			importer,
			["linked/new-source.ts"],
			false,
			"symlink target escapes scratch",
		);
		const workspace = { packageDir: "packages/demo", name: "@example/new" };
		const line = (from: string) =>
			[
				"error: Cannot find package '@example/new/entry' from '",
				from,
				"'",
			].join("");
		expect(
			missingImportsExplained(
				line(importer),
				[],
				f.input.testFiles,
				[workspace],
				f.repo,
			),
		).toBe(true);
		expect(
			missingImportsExplained(
				line(join(f.home, "packages/demo/test/proof@unit.e2e.ts")),
				[],
				f.input.testFiles,
				[workspace],
				f.repo,
			),
		).toBe(false);
	} finally {
		f.clean();
	}
});

test("explained global errors cannot mask an unselected executed spec", async () => {
	const f = fixture();
	try {
		const error = [
			"Cannot find module '../../../new-source.ts' from '",
			f.repo,
			"/packages/demo/test/proof@unit.e2e.ts'",
		].join("");
		const output = report(f.repo, {
			errors: [{ message: error }],
			stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0 },
			suites: [
				{
					specs: [
						{
							file: "packages/demo/test/proof@unit.e2e.ts",
							tests: [{ status: "expected" }],
						},
						{
							file: "packages/demo/test/other.e2e.ts",
							tests: [{ status: "expected" }],
						},
					],
				},
			],
		});
		const result = await runCoverageGroups(
			{ ...f.input, groups: [f.input.groups[1]], addedProd: ["new-source.ts"] },
			{
				run: async () => ({
					code: 1,
					signal: null,
					stdout: Buffer.from(output),
					stderr: Buffer.alloc(0),
				}),
			},
		);
		expect(result.status).toBe("unknown");
		expect(result.detail).toContain("unexpected collected spec");
	} finally {
		f.clean();
	}
});
