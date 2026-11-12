// Shared exact payload staging for the image builder and layout regression.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const writeJson = (dest: string, value: unknown): void => {
	writeFileSync(dest, `${JSON.stringify(value, null, "\t")}\n`);
};

/** Stage the exact payload the image copies; returns the package version. */
export const stagePayload = (PKG: string, REPO: string, STAGE: string): string => {
	const pkgJson = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
	rmSync(STAGE, { recursive: true, force: true });
	mkdirSync(join(STAGE, "seed"), { recursive: true });
	mkdirSync(join(STAGE, "vendor/@klh/buckle/src"), { recursive: true });
	cpSync(join(PKG, "src"), join(STAGE, "src"), { recursive: true });
	cpSync(join(PKG, "seed/payload/readiness.ts"), join(STAGE, "seed/readiness.ts"));
	cpSync(join(PKG, "seed/payload/policy.json"), join(STAGE, "seed/policy.json"));
	// Minimal @klh/buckle face: the seed's only buckle import is
	// @klh/buckle/src/log (dependency-free). Full buckle drags
	// blam/settings/speedy/telemetry — against the minimal-payload law.
	cpSync(
		join(REPO, "packages/buckle/src/log.ts"),
		join(STAGE, "vendor/@klh/buckle/src/log.ts"),
	);
	writeJson(join(STAGE, "vendor/@klh/buckle/package.json"), {
		name: "@klh/buckle",
		version: pkgJson.dependencies["@klh/buckle"],
		private: true,
		description: "Minimal seed face: log only (W2958 staging)",
		type: "module",
	});
	writeJson(join(STAGE, "package.json"), {
		...pkgJson,
		dependencies: {
			...pkgJson.dependencies,
			"@klh/buckle": "file:./vendor/@klh/buckle",
		},
		devDependencies: undefined,
	});
	return pkgJson.version as string;
};

