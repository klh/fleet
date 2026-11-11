import {
	copyFile,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const MetafileSchema = z.object({ inputs: z.record(z.string(), z.unknown()) });
const PackageNoticeSchema = z.object({
	name: z.string(),
	version: z.string(),
	license: z.string().optional(),
});
const entries = [
	"packages/buckle/src/server.ts",
	"packages/suspenders/deploy/healthcheck/probe.ts",
];
const inputs = new Set<string>();
for (const entry of entries) {
	const destination = join("/runtime", entry);
	mkdirSync(dirname(destination), { recursive: true });
	const metadata = `/tmp/${entry.includes("buckle") ? "buckle" : "probe"}-metafile.json`;
	const child = Bun.spawnSync(
		[
			"bun",
			"build",
			entry,
			"--target=bun",
			"--packages=bundle",
			"--minify-whitespace",
			`--metafile=${metadata}`,
			`--outfile=${destination}`,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (child.exitCode !== 0) throw new Error(`Bundle failed: ${entry}`);
	for (const path of Object.keys(
		MetafileSchema.parse(JSON.parse(readFileSync(metadata, "utf8"))).inputs,
	)) {
		if (
			/(^|\/)(bench|benchmark|dataset|eval|judges?|fixtures?|test|tests)(\/|$)/.test(
				path,
			)
		)
			throw new Error(`Non-runtime asset in bundle: ${path}`);
		inputs.add(path);
	}
}

const roots = new Set<string>();
for (const input of inputs) {
	let folder = dirname(resolve(input));
	while (
		!existsSync(join(folder, "package.json")) ||
		!PackageNoticeSchema.safeParse(
			JSON.parse(readFileSync(join(folder, "package.json"), "utf8")),
		).success
	) {
		const parent = dirname(folder);
		if (parent === folder) throw new Error(`Package notice missing: ${input}`);
		folder = parent;
	}
	roots.add(folder);
}
const notices = [];
for (const root of roots) {
	const pkg = PackageNoticeSchema.parse(
		JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
	);
	const destination = join(
		"/runtime/licenses",
		pkg.name.replace(/[^a-z0-9.-]/gi, "_"),
	);
	mkdirSync(destination, { recursive: true });
	const names = readdirSync(root).filter((name) =>
		/^(license|notice)(\.|$)/i.test(name),
	);
	if (!names.length && !root.startsWith("/fleet/packages/"))
		throw new Error(`License missing: ${pkg.name}`);
	for (const name of names) {
		await new Promise<void>((done, fail) =>
			copyFile(join(root, name), join(destination, name), (error) =>
				error ? fail(error) : done(),
			),
		);
	}
	writeFileSync(
		join(destination, "package.json"),
		`${JSON.stringify(pkg, null, 2)}\n`,
	);
	notices.push(pkg);
}
await Bun.write("/runtime/LICENSE", Bun.file("/fleet/LICENSE"));
const EmptySeedUpstreamsSchema = z.strictObject({
	version: z.literal(1),
	groups: z.record(z.string(), z.array(z.never())),
});
const neutral = EmptySeedUpstreamsSchema.parse({ version: 1, groups: {} });
const upstreamsPath = "/runtime/packages/buckle/upstreams.json";
writeFileSync(upstreamsPath, `${JSON.stringify(neutral)}\n`);
const { loadUpstreams } = await import("../src/upstreams.ts");
if (loadUpstreams(upstreamsPath).groups().length)
	throw new Error("Seed default must contain no model routes");
writeFileSync(
	"/runtime/runtime-closure.json",
	`${JSON.stringify({ schemaVersion: 1, entries, inputs: [...inputs].sort(), packages: notices }, null, 2)}\n`,
);
