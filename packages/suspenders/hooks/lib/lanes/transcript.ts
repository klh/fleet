// hooks/lib/lanes/transcript.ts — W642: transcript resolution for worktree lanes.
// Claude Code encodes each cwd into a project dir under ~/.claude/projects
// (every non-alphanumeric → "-"). A worktree session's transcript can live
// under a DIFFERENT encoded dir than the path the hook receives, so a
// transcript_path can point at a file that does not exist (OMC issue #1094).
// Every transcript-reading gate resolves through here: the hook path when it
// exists, else the --claude-worktrees-<name> strip, else the main repo's
// encoded projects dir (via git-common-dir), else the cwd's own encoding.
// Never scans ~/.claude/todos for anything (OMC issue #354 — phantom counts).
import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { run } from "../run.ts";

function realpathSafe(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** Claude Code's project-dir encoding: every non-alphanumeric becomes "-". */
export function encodeProjectDir(p: string): string {
	return p.replace(/[^a-zA-Z0-9]/g, "-");
}

export type TranscriptRef = {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
};

const directoryNames = (root: string, pattern: RegExp): string[] => {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && pattern.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.reverse();
	} catch {
		return [];
	}
};

/** Codex rollouts are date-partitioned, so match the exact UUID filename
 * suffix rather than trusting a session-supplied path or scanning content. */
const codexRollout = (sessions: string, sid: string): string | null => {
	if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sid)) return null;
	for (const year of directoryNames(sessions, /^\d{4}$/)) {
		const yearPath = join(sessions, year);
		for (const month of directoryNames(yearPath, /^\d{2}$/)) {
			const monthPath = join(yearPath, month);
			for (const day of directoryNames(monthPath, /^\d{2}$/)) {
				const dayPath = join(monthPath, day);
				try {
					const match = readdirSync(dayPath, { withFileTypes: true }).find(
						(entry) =>
							entry.isFile() &&
							entry.name.startsWith("rollout-") &&
							entry.name.endsWith(`-${sid}.jsonl`),
					);
					if (match) return join(dayPath, match.name);
				} catch {
					// Missing or unreadable day: try the remaining date partitions.
				}
			}
		}
	}
	return null;
};

/** The one resolution order — first candidate that exists wins, null fails
 * OPEN for the caller (a resolution miss must never flip a gate verdict).
 * projectsRoot overrides the transcript home (tests); default $HOME. */
export function resolveTranscriptPath(
	hook: TranscriptRef,
	projectsRoot?: string,
): string | null {
	const file =
		hook.transcript_path && hook.transcript_path.length > 0
			? basename(hook.transcript_path)
			: hook.session_id
				? `${hook.session_id}.jsonl`
				: null;
	if (!file) return null;
	if (hook.transcript_path && existsSync(hook.transcript_path))
		return hook.transcript_path;
	const home = process.env.HOME ?? "";
	const projects = projectsRoot ?? (home ? `${home}/.claude/projects` : "");
	if (!projects) return null;
	const candidates: string[] = [];
	// OMC #1094 strip: a `--claude-worktrees-<name>` suffix segment in the
	// encoded dir belongs to Claude Code's own worktree feature — the file
	// lives in the main repo's dir without that segment
	const baseDir = hook.transcript_path ? dirname(hook.transcript_path) : "";
	if (baseDir)
		candidates.push(
			`${projects}/${baseDir
				.split("/")
				.pop()
				?.replace(/--claude-worktrees-[^/]+$/, "")}/${file}`,
		);
	// main repo root via git-common-dir: fleet worktrees sit at
	// <repo>/.worktrees/<id>, so the main checkout's encoded dir is the
	// one the transcript actually lands in for worktree lanes. macOS tmp
	// dirs symlink (/var → /private/var) and git realpaths — try BOTH the
	// raw and the realpath encoding.
	if (hook.cwd) {
		const common = run(
			"git",
			["-C", hook.cwd, "rev-parse", "--git-common-dir"],
			{ cwd: hook.cwd },
		);
		if (common.ok) {
			const rawRoot = dirname(resolve(hook.cwd, common.out.trim()));
			for (const root of new Set([rawRoot, realpathSafe(rawRoot)]))
				candidates.push(`${projects}/${encodeProjectDir(root)}/${file}`);
		}
		candidates.push(`${projects}/${encodeProjectDir(hook.cwd)}/${file}`);
	}
	for (const c of candidates) if (existsSync(c)) return c;
	const codexHome = projectsRoot ? dirname(dirname(projectsRoot)) : home;
	return hook.session_id
		? codexRollout(join(codexHome, ".codex/sessions"), hook.session_id)
		: null;
}

/** The last `bytes` of a transcript as text — bounded tail, never the whole
 * file (streams-over-buffers). Empty string on ANY failure (fail open). */
export function transcriptTail(path: string, bytes = 4096): string {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, size - start, start);
		return buf.toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== null) closeSync(fd);
	}
}
