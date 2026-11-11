import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { HOST_BUILD_PINS, runtimeInputKind } from "./contract.ts";

const MetafileSchema = z.object({ inputs: z.record(z.string(), z.unknown()) });
const PackageNoticeSchema = z.object({
	name: z.string(),
	version: z.string(),
	license: z.string().optional(),
});
const entries = {
	"runner-control": "packages/suspenders/hooks/bin/runner-control.ts",
	health: "packages/suspenders/deploy/host/health.ts",
};
mkdirSync("/runtime", { recursive: true });
const inputs = new Set<string>();
for (const [name, entry] of Object.entries(entries)) {
	const metadata = `/tmp/${name}-metafile.json`;
	const child = Bun.spawnSync(
		[
			"bun",
			"build",
			entry,
			"--target=bun",
			"--packages=bundle",
			"--minify-whitespace",
			`--metafile=${metadata}`,
			`--outfile=/runtime/${name}.js`,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (child.exitCode !== 0) throw new Error(`Runtime bundle failed: ${name}`);
	for (const path of Object.keys(
		MetafileSchema.parse(JSON.parse(readFileSync(metadata, "utf8"))).inputs,
	)) {
		runtimeInputKind(path);
		inputs.add(path);
	}
}
const roots = new Set<string>();
for (const input of inputs) {
	let folder = dirname(resolve(input));
	while (!existsSync(join(folder, "package.json"))) {
		const parent = dirname(folder);
		if (parent === folder) throw new Error(`No package for input: ${input}`);
		folder = parent;
	}
	roots.add(folder);
}
const packages = [];
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
		/^(licen[cs]e|notice)(\.|$)/i.test(name),
	);
	if (!names.length && !root.startsWith("/fleet/packages/"))
		throw new Error(`Missing license: ${pkg.name}`);
	for (const name of names)
		copyFileSync(join(root, name), join(destination, name));
	writeFileSync(
		join(destination, "package.json"),
		`${JSON.stringify(pkg, null, 2)}\n`,
	);
	packages.push(pkg);
}
copyFileSync("/fleet/LICENSE", "/runtime/LICENSE");

// Preserve the static Docker CLI's source/vendor notices, without shipping code.
function copyDockerNotices(folder: string, relative = "") {
	for (const entry of readdirSync(folder, { withFileTypes: true })) {
		const path = join(folder, entry.name);
		const child = join(relative, entry.name);
		if (entry.isDirectory()) copyDockerNotices(path, child);
		else if (
			entry.isFile() &&
			/^(licen[cs]e|notice|copying|copyright)([.-]|$)/i.test(entry.name)
		) {
			const target = join("/runtime/licenses/docker-cli", child);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(path, target);
		}
	}
}
copyDockerNotices("/docker-cli-source");
const docker = Bun.spawnSync(["docker", "--version"], {
	stdout: "pipe",
	stderr: "pipe",
});
if (
	docker.exitCode !== 0 ||
	!docker.stdout
		.toString()
		.includes(`Docker version ${HOST_BUILD_PINS.dockerVersion},`)
)
	throw new Error("Docker CLI identity mismatch");
const sdkEvaluationClientInputs = [...inputs]
	.filter((path) => runtimeInputKind(path) === "sdk-evaluation-client")
	.sort()
	.map((path) => ({
		path,
		package: "openai",
		version: "7.19.0",
		sha256: new Bun.CryptoHasher("sha256")
			.update(readFileSync(path))
			.digest("hex"),
	}));
if (
	sdkEvaluationClientInputs.length &&
	!packages.some((pkg) => pkg.name === "openai" && pkg.version === "7.19.0")
)
	throw new Error("SDK client package identity mismatch");
writeFileSync(
	"/runtime/runtime-closure.json",
	`${JSON.stringify(
		{
			schemaVersion: 1,
			entries,
			inputs: [...inputs].sort(),
			packages,
			sdkEvaluationClientInputs,
			dockerCli: {
				image: HOST_BUILD_PINS.docker,
				version: HOST_BUILD_PINS.dockerVersion,
				sourceCommit: HOST_BUILD_PINS.dockerCommit,
				binarySha256: new Bun.CryptoHasher("sha256")
					.update(readFileSync("/usr/local/bin/docker"))
					.digest("hex"),
				bytes: statSync("/usr/local/bin/docker").size,
			},
			architecture: process.arch,
		},
		null,
		2,
	)}\n`,
);
