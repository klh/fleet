// settings.tree.ts — plain-object helpers over the settings document:
// dotted-path get/set/unset, deep merge (objects merge, arrays and scalars
// replace), and the leaf walk the --origin view rides. Pure; no I/O.

export type Doc = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is Doc =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export const splitPath = (p: string): string[] =>
	p
		.split(".")
		.map((s) => s.trim())
		.filter(Boolean);

export function getPath(doc: unknown, path: string): unknown {
	let cur: unknown = doc;
	for (const seg of splitPath(path)) {
		if (!isPlainObject(cur)) return undefined;
		cur = cur[seg];
	}
	return cur;
}

/** Copy-on-write set: returns a new document with `path` set to `value`,
 *  creating intermediate objects. */
export function setPath(doc: Doc, path: string, value: unknown): Doc {
	const segs = splitPath(path);
	if (segs.length === 0) throw new Error("settings: empty path");
	const root: Doc = structuredClone(doc);
	let cur: Doc = root;
	for (const seg of segs.slice(0, -1)) {
		const next = cur[seg];
		const obj: Doc = isPlainObject(next) ? next : {};
		cur[seg] = obj;
		cur = obj;
	}
	cur[segs[segs.length - 1] ?? ""] = value;
	return root;
}

/** Copy-on-write unset; empty parent objects are pruned. */
export function unsetPath(doc: Doc, path: string): Doc {
	const segs = splitPath(path);
	const root: Doc = structuredClone(doc);
	const chain: Doc[] = [root];
	for (const seg of segs.slice(0, -1)) {
		const next = chain[chain.length - 1]?.[seg];
		if (!isPlainObject(next)) return root;
		chain.push(next);
	}
	delete chain[chain.length - 1]?.[segs[segs.length - 1] ?? ""];
	for (let i = chain.length - 1; i > 0; i--) {
		const node = chain[i];
		if (node && Object.keys(node).length === 0)
			delete chain[i - 1]?.[segs[i - 1] ?? ""];
	}
	return root;
}

/** Deep merge: plain objects merge key-by-key; everything else in
 *  `overlay` replaces. Neither input is mutated. */
export function deepMerge(base: unknown, overlay: unknown): unknown {
	if (!isPlainObject(base) || !isPlainObject(overlay))
		return overlay === undefined
			? structuredClone(base)
			: structuredClone(overlay);
	const out: Doc = structuredClone(base);
	for (const [k, v] of Object.entries(overlay)) out[k] = deepMerge(out[k], v);
	return out;
}

/** Every leaf path of a document (records walk too; arrays are leaves). */
export function leafPaths(doc: unknown, prefix = ""): string[] {
	if (!isPlainObject(doc)) return prefix ? [prefix] : [];
	const keys = Object.keys(doc);
	if (keys.length === 0) return prefix ? [prefix] : [];
	return keys.flatMap((k) => leafPaths(doc[k], prefix ? `${prefix}.${k}` : k));
}

/** True when the raw document carries a value at `path` (or under it). */
export const hasPath = (doc: unknown, path: string): boolean =>
	getPath(doc, path) !== undefined;
