// A router process reports the import closure it loaded at startup. The
// outside-process supervisor compares it with the current flat runtime home,
// so a healthy old router cannot hide a newly installed trace or route module.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const RELATIVE_IMPORT =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.\.?\/[^"']+)["']/g;

/** Null means the closure is incomplete or is being refreshed: keep serving
 * the old process until installation has a complete replacement. */
export function routerRuntimeRevision(entry: string): string | null {
	const root = dirname(resolve(entry));
	if (existsSync(join(root, ".belt-overlay.lock"))) return null;
	const pending = [resolve(entry)];
	const seen = new Set<string>();
	const hash = createHash("sha256");
	while (pending.length > 0) {
		pending.sort();
		const path = pending.shift() as string;
		if (seen.has(path)) continue;
		seen.add(path);
		if (seen.size > 256) return null;
		let source: string;
		try {
			source = readFileSync(path, "utf8");
		} catch {
			return null;
		}
		hash.update(relative(root, path));
		hash.update("\0");
		hash.update(source);
		hash.update("\0");
		for (const match of source.matchAll(RELATIVE_IMPORT)) {
			const specifier = match[1]?.split("?")[0];
			if (specifier) pending.push(resolve(dirname(path), specifier));
		}
	}
	return hash.digest("hex");
}
