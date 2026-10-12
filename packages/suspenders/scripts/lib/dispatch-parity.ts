import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Compare helpers used by the active entry, including old flat installs. */
export function inspectDispatchParity(repo: string, prefix: string): string[] {
	const source = join(repo, "packages/suspenders/scripts/lib");
	if (!existsSync(source)) return ["repo scripts/lib gone"];
	const entry = join(prefix, "bin/fleet-loop.ts");
	if (!existsSync(entry)) return [`${entry} (missing entry)`];
	const depths = new Set(
		[
			join(prefix, "scripts/lib"),
			resolve(dirname(realpathSync(entry)), "../../scripts/lib"),
		].map((path) => (existsSync(path) ? realpathSync(path) : path)),
	);
	const missing: string[] = [];
	for (const file of readdirSync(source).filter((file) =>
		file.endsWith(".ts"),
	)) {
		for (const depth of depths) {
			const target = join(depth, file);
			if (!existsSync(target)) missing.push(target);
			else if (!readFileSync(target).equals(readFileSync(join(source, file))))
				missing.push(`${target} (stale bytes)`);
		}
	}
	return missing;
}
