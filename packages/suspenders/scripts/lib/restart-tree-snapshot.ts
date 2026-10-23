import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
	realpathSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";

export type RestartTreeLimits = {
	entries: number;
	bytes: number;
	depth: number;
	durationMs: number;
};
const LIMITS: RestartTreeLimits = {
	entries: 10000,
	bytes: 256 * 1024 * 1024,
	depth: 48,
	durationMs: 10000,
};
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const artifact = (name: string): boolean =>
	name === ".klh-brief.md" ||
	name.startsWith(".fleet/") ||
	name.split("/").includes("node_modules");
const inside = (root: string, path: string): boolean => {
	const r = relative(root, path);
	return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
};
const stamp = (s: ReturnType<typeof lstatSync>): string =>
	JSON.stringify([s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs]);

/** A bounded, read-only snapshot of the repository's own bytes. Git may
 * report an untracked embedded repository as one directory; walk it without
 * executing its Git configuration. Never follow references outside the tree. */
export function restartTreeHash(
	cwd: string,
	limits: RestartTreeLimits = LIMITS,
): string {
	const root = realpathSync(cwd),
		deadline = performance.now() + limits.durationMs;
	let count = 0,
		bytes = 0;
	const check = () => {
		if (performance.now() > deadline)
			throw Error("Restart tree snapshot duration exceeded");
	};
	const git = (args: string[]): string => {
		check();
		const p = Bun.spawnSync(["git", ...args], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
			maxBuffer: 16 * 1024 * 1024,
			timeout: Math.max(1, Math.min(5000, deadline - performance.now())),
		});
		if (p.exitCode !== 0)
			throw Error(
				"Restart tree Git evidence unavailable or bounded output exceeded",
			);
		return p.stdout.toString();
	};
	const head = git(["rev-parse", "HEAD"]).trim();
	const diffArgs = [
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--binary",
		"HEAD",
	];
	const diff = git(diffArgs);
	const namesArgs = ["ls-files", "--others", "--exclude-standard", "-z"];
	const listing = git(namesArgs);
	const names = listing
		.split("\0")
		.filter((name) => name && !artifact(name))
		.sort();
	const entries = new Map<string, unknown>();
	const buffer = Buffer.alloc(64 * 1024);
	const reference = (base: string, target: string) => {
		const path = resolve(base, target);
		if (!inside(root, path) || !inside(root, realpathSync(path)))
			throw Error("Restart tree embedded Git reference escapes worktree");
	};
	const referenceFile = (name: string): boolean => {
		const parts = name.split("/");
		return (
			basename(name) === ".git" ||
			(parts.includes(".git") &&
				["commondir", "gitdir", "alternates"].includes(basename(name)))
		);
	};
	const metadata = (path: string, name: string, text: string) => {
		text = text.trim();
		if (basename(name) === ".git") {
			const match = /^gitdir: (.+)$/.exec(text);
			if (!match)
				throw Error("Restart tree Git directory reference is invalid");
			reference(dirname(path), match[1]);
		} else if (basename(name) === "alternates") {
			for (const target of text.split("\n").filter(Boolean))
				reference(dirname(dirname(path)), target);
		} else reference(dirname(path), text);
	};
	const visit = (
		path: string,
		name: string,
		depth: number,
		ancestors: Set<string>,
	): void => {
		check();
		if (artifact(name)) return;
		if (++count > limits.entries || depth > limits.depth)
			throw Error("Restart tree snapshot entry/depth bound exceeded");
		if (!inside(root, path) || !inside(root, realpathSync(dirname(path))))
			throw Error("Restart tree path escapes worktree");
		const before = lstatSync(path);
		if (before.isSymbolicLink()) {
			if (name.split("/").includes(".git"))
				throw Error("Restart tree symlinked Git metadata is not supported");
			const target = readlinkSync(path),
				actual = realpathSync(path);
			if (!inside(root, actual))
				throw Error("Restart tree symlink escapes worktree");
			if (ancestors.has(actual)) throw Error("Restart tree symlink cycle");
			entries.set(name, { symlink: target });
			visit(actual, `${name}/@target`, depth + 1, ancestors);
		} else if (before.isDirectory()) {
			const actual = realpathSync(path);
			if (ancestors.has(actual)) throw Error("Restart tree directory cycle");
			const next = new Set(ancestors).add(actual);
			entries.set(`${name}/`, { directory: true });
			for (const child of readdirSync(path).sort())
				visit(resolve(path, child), `${name}/${child}`, depth + 1, next);
		} else if (before.isFile()) {
			if (bytes + before.size > limits.bytes)
				throw Error("Restart tree snapshot byte bound exceeded");
			const physicalName = relative(root, path).split(sep).join("/");
			const isReference = referenceFile(physicalName);
			if (isReference && before.size > 64 * 1024)
				throw Error("Restart tree Git reference exceeds bound");
			const referenceChunks: Buffer[] = [];
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				if (stamp(fstatSync(fd)) !== stamp(before))
					throw Error("Restart tree changed before reading");
				const digest = createHash("sha256");
				let size = 0;
				for (;;) {
					check();
					const read = readSync(fd, buffer, 0, buffer.length, null);
					if (!read) break;
					bytes += read;
					size += read;
					if (bytes > limits.bytes)
						throw Error("Restart tree snapshot byte bound exceeded");
					digest.update(buffer.subarray(0, read));
					if (isReference)
						referenceChunks.push(Buffer.from(buffer.subarray(0, read)));
				}
				if (size !== before.size || stamp(fstatSync(fd)) !== stamp(before))
					throw Error("Restart tree changed during reading");
				if (isReference)
					metadata(
						path,
						physicalName,
						Buffer.concat(referenceChunks).toString("utf8"),
					);
				entries.set(name, digest.digest("hex"));
			} finally {
				closeSync(fd);
			}
		} else throw Error("Restart tree contains unsupported special file");
		if (stamp(lstatSync(path)) !== stamp(before))
			throw Error("Restart tree changed during snapshot");
	};
	for (const original of names) {
		const name = original.replace(/\/$/, "");
		if (
			!name ||
			isAbsolute(name) ||
			name.split("/").some((part) => part === "..")
		)
			throw Error("Restart tree Git path is not relative");
		visit(resolve(root, name), name, 0, new Set([root]));
	}
	if (
		git(["rev-parse", "HEAD"]).trim() !== head ||
		git(diffArgs) !== diff ||
		git(namesArgs) !== listing
	)
		throw Error("Restart tree Git state changed during snapshot");
	return hash(
		JSON.stringify([
			head,
			diff,
			...[...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		]),
	);
}
