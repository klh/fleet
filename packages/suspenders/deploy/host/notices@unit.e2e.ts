import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import {
	packageRoot,
	PI_NOTICE,
	sourceNotice,
	verifyPiLicense,
} from "./contract.ts";

test("notice root skips nested module-only package metadata @unit", async () => {
	const world = scratchWorld();
	try {
		const nested = join(world.home, "package/v4/core");
		await mkdir(nested, { recursive: true });
		await writeFile(
			join(world.home, "package/package.json"),
			JSON.stringify({
				name: "fixture-package",
				version: "1.0.0",
				license: "MIT",
			}),
		);
		await writeFile(
			join(world.home, "package/v4/package.json"),
			JSON.stringify({ type: "module" }),
		);
		expect(packageRoot(join(nested, "index.js"))).toBe(
			join(world.home, "package"),
		);
		await writeFile(
			join(world.home, "package/v4/package.json"),
			JSON.stringify({ name: "malformed", version: "1.0.0", license: 42 }),
		);
		expect(() => packageRoot(join(nested, "index.js"))).toThrow();
		await writeFile(join(world.home, "package/v4/package.json"), "{");
		expect(() => packageRoot(join(nested, "index.js"))).toThrow();
		expect(() => packageRoot("/")).toThrow("Package identity missing");
	} finally {
		world.clean();
	}
});

test("only exact upstream packages missing published notices use pinned source license @unit", async () => {
	for (const [name, directory] of [
		["chord", "chord"],
		["pi-ai", "ai"],
		["pi-durable", "durable"],
		["pi-schema", "schema"],
		["pi-telemetry", "telemetry"],
	]) {
		const pkg = {
			name: `@earendil-works/${name}`,
			version: "1.5.0",
			license: "MIT",
			repository: {
				type: "git",
				url: "git+https://github.com/earendil-works/pi.git",
				directory: `packages/${directory}`,
			},
		};
		expect(sourceNotice(pkg)).toEqual({
			...PI_NOTICE,
			packageName: pkg.name,
			packageVersion: pkg.version,
			repositoryDirectory: `packages/${directory}`,
		});
		for (const override of [
			{ version: "1.5.1" },
			{ license: "UNKNOWN" },
			{ name: "@spoof/pi-ai" },
			{ repository: { ...pkg.repository, url: "https://private.invalid/pi" } },
			{ repository: { ...pkg.repository, directory: "private/judges" } },
		])
			expect(sourceNotice({ ...pkg, ...override })).toBeUndefined();
	}
	const dockerfile = await Bun.file(
		new URL("./Dockerfile", import.meta.url),
	).text();
	const license = await Bun.file(
		new URL("./pi-license.fixture.txt", import.meta.url),
	).bytes();
	expect(verifyPiLicense(license)).toEqual(license);
	const corrupt = new Uint8Array(license);
	corrupt[0] ^= 1;
	expect(() => verifyPiLicense(corrupt)).toThrow("checksum mismatch");
	expect(dockerfile).toContain(
		`--checksum=sha256:${PI_NOTICE.sha256} ${PI_NOTICE.url}`,
	);
});
