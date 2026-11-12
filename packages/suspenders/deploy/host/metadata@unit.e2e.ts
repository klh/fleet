import { expect, test } from "@playwright/test";
import { imageCreated, type StageRunner } from "./build.ts";
import { scratchWorld } from "@klh/test-kit";
import { hostProcess } from "./process.ts";
test("immutable creation ignores Git replacement refs @unit", async () => {
	const world = scratchWorld();
	try {
		const git = async (args: string[]) => {
			const r = await hostProcess(["git", ...args], {
				cwd: world.repo,
				timeoutMs: 5000,
				maxBytes: 4096,
			});
			expect(r.code).toBe(0);
			return new TextDecoder().decode(r.stdout).trim();
		};
		const tree = await git(["rev-parse", "HEAD^{tree}"]);
		const commit = async (epoch: number) => {
			const path = `${world.repo}/${epoch}`;
			await Bun.write(
				path,
				`tree ${tree}\nauthor Fixture <fixture@example.invalid> ${epoch} +0000\ncommitter Fixture <fixture@example.invalid> ${epoch} +0000\n\nfixture\n`,
			);
			return git(["hash-object", "-t", "commit", "-w", path]);
		};
		const a = await commit(1700000000),
			b = await commit(1800000000);
		await git(["replace", a, b]);
		expect(await git(["show", "-s", "--format=%ct", a])).toBe("1800000000");
		expect((await imageCreated(a, a, world.repo)).epochSeconds).toBe(
			1700000000,
		);
	} finally {
		world.clean();
	}
});

const source = "a".repeat(40),
	recipe = "b".repeat(40),
	bytes = (value: string) => new TextEncoder().encode(value);
for (const [s, r] of [
	[1700000000, 1700000100],
	[1700000100, 1700000000],
	[1700000000, 1700000000],
])
	test(`immutable creation max ${s}/${r} @unit`, async () => {
		const run: StageRunner = async (argv, cwd) => {
			expect(cwd).toBe("/fixture");
			expect([source, recipe]).toContain(argv.at(-1));
			if (argv[2] === "cat-file") {
				expect(argv.slice(0, 4)).toEqual([
					"git",
					"--no-replace-objects",
					"cat-file",
					"-t",
				]);
				return bytes("commit\n");
			}
			expect(argv.slice(0, 5)).toEqual([
				"git",
				"--no-replace-objects",
				"show",
				"-s",
				"--format=%ct",
			]);
			return bytes(`${String(argv.at(-1) === source ? s : r)}\n`);
		};
		const epochSeconds = Math.max(s, r);
		expect(await imageCreated(source, recipe, "/fixture", run)).toEqual({
			created: new Date(epochSeconds * 1000).toISOString(),
			epochSeconds,
			sourceEpochSeconds: s,
			recipeEpochSeconds: r,
		});
	});
for (const value of [
	"",
	"-1",
	"9007199254740992",
	"253402300800",
	"not-a-time",
])
	test(`invalid immutable timestamp ${JSON.stringify(value)} refuses @unit`, async () => {
		const run: StageRunner = async (argv) =>
			bytes(argv[2] === "cat-file" ? "commit" : value);
		await expect(imageCreated(source, recipe, "/fixture", run)).rejects.toThrow(
			"Immutable commit timestamp unavailable",
		);
	});
for (const type of ["blob", "tag", "tree", "missing"])
	test(`noncommit ${type} refuses before time read @unit`, async () => {
		let reads = 0;
		const run: StageRunner = async (argv) => {
			if (type === "missing") throw Error("private-upstream-marker");
			if (argv[2] === "show") reads++;
			return bytes(type);
		};
		await expect(imageCreated(source, recipe, "/fixture", run)).rejects.toThrow(
			/^Immutable commit timestamp unavailable$/,
		);
		expect(reads).toBe(0);
	});

test("OCI identity belongs to the Fleet HOST supervisor recipe @unit", async () => {
	const recipe = await Bun.file(
		new URL("./Dockerfile", import.meta.url),
	).text();
	for (const label of [
		'org.opencontainers.image.title="Fleet HOST supervisor"',
		'org.opencontainers.image.description="Fleet production runner-control HOST supervisor"',
		'org.opencontainers.image.url="https://github.com/klh/fleet/tree/main/packages/suspenders/deploy/host"',
		'org.opencontainers.image.created="$CREATED"',
	])
		expect(recipe).toContain(label);
	expect(recipe).toContain("ARG CREATED");
});
test("bounded Git accepts a real commit and refuses timestamp-shaped blob @unit", async () => {
	const world = scratchWorld();
	try {
		const git = async (args: string[]) => {
			const r = await hostProcess(["git", ...args], {
				cwd: world.repo,
				timeoutMs: 5000,
				maxBytes: 4096,
			});
			expect(r.code).toBe(0);
			return new TextDecoder().decode(r.stdout).trim();
		};
		const commit = await git(["rev-parse", "HEAD"]),
			expected = Number(await git(["show", "-s", "--format=%ct", commit]));
		expect((await imageCreated(commit, commit, world.repo)).epochSeconds).toBe(
			expected,
		);
		await Bun.write(`${world.repo}/timestamp-blob`, "1700000000");
		const blob = await git(["hash-object", "-w", "timestamp-blob"]);
		await expect(imageCreated(blob, commit, world.repo)).rejects.toThrow(
			"Immutable commit timestamp unavailable",
		);
		await expect(
			imageCreated("f".repeat(40), commit, world.repo),
		).rejects.toThrow("Immutable commit timestamp unavailable");
	} finally {
		world.clean();
	}
});
