#!/usr/bin/env bun
// Local, resumable organization document index. Source ACL is the gh login:
// never serve this database to another principal. Source code stays on GitHub.
import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface Config {
	org: string;
	db: string;
	batch?: number;
	filesPerRun?: number;
	mirrors: string;
}
interface RepoRow {
	nameWithOwner: string;
	pushedAt: string | null;
	defaultBranchRef: { name: string } | null;
	diskUsage: number | null;
}
interface TreeEntry {
	path: string;
	type: string;
	sha: string;
	size?: number;
}

const configPath =
	process.env.KLH_ORG_INDEX_CONFIG ??
	join(homedir(), ".config/klh/knowledge-index.json");
const verb = process.argv[2] ?? "status";
if (!["sync", "status", "search", "stale"].includes(verb))
	throw new Error(
		"usage: org-knowledge-index.ts sync|status|search <q>|stale <id> <reason>",
	);
let config: Config;
try {
	config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
} catch {
	if (verb === "sync") process.exit(0); // machine has not enrolled an org
	throw new Error(`index not configured: ${configPath}`);
}
if (!/^[A-Za-z0-9-]+$/.test(config.org)) throw new Error("invalid org");
if (!config.db.startsWith("/")) throw new Error("db must be an absolute path");
if (!config.mirrors?.startsWith("/"))
	throw new Error("mirrors must be an absolute path");
if ((statSync(configPath).mode & 0o077) !== 0)
	throw new Error("config must be mode 0600");
mkdirSync(dirname(config.db), { recursive: true, mode: 0o700 });
mkdirSync(config.mirrors, { recursive: true, mode: 0o700 });
const db = new Database(config.db, { create: true });
chmodSync(config.db, 0o600);
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS repos (
 name TEXT PRIMARY KEY, branch TEXT NOT NULL, pushed_at TEXT,
 disk_kib INTEGER, indexed_pushed_at TEXT, head_sha TEXT,
 cursor_path TEXT NOT NULL DEFAULT '', indexed_at INTEGER,
 last_error TEXT, last_attempt_at INTEGER
);
CREATE TABLE IF NOT EXISTS docs (
 id TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL,
 blob_sha TEXT NOT NULL, head_sha TEXT NOT NULL, title TEXT NOT NULL,
 body TEXT NOT NULL, line_count INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'current', indexed_at INTEGER NOT NULL,
 stale_reason TEXT, stale_at INTEGER,
 UNIQUE(repo,path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED,title,body);
CREATE INDEX IF NOT EXISTS docs_repo ON docs(repo,state);
`);
const columns = db.query("PRAGMA table_info(repos)").all() as Array<{
	name: string;
}>;
if (!columns.some((column) => column.name === "target_pushed_at"))
	db.exec("ALTER TABLE repos ADD COLUMN target_pushed_at TEXT");

async function run(argv: string[], maxBytes = 16_000_000): Promise<string> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), 180_000);
	try {
		const [code, out, err] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		if (code !== 0)
			throw new Error(`${argv[0]} exit ${code}: ${err.slice(0, 300)}`);
		if (out.length > maxBytes) throw new Error("source response too large");
		return out;
	} finally {
		clearTimeout(timer);
	}
}

export function indexable(path: string, size = 0): boolean {
	if (size > 262_144) return false;
	if (
		/(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.next|target)\//i.test(
			path,
		)
	)
		return false;
	return (
		/(^|\/)(README|AGENTS|CONTRIBUTING|ARCHITECTURE|DEPLOY|RUNBOOK)(\.[a-z0-9]+)?$/i.test(
			path,
		) ||
		/(^|\/)(docs?|documentation)\/.*\.(md|mdx|txt|rst|adoc|ya?ml|json)$/i.test(
			path,
		) ||
		/(^|\/)(src|app|lib|services|packages|api|functions|internal|cmd)\/.*\.(ts|tsx|js|jsx|go|py|java|kt|cs|rs|tf)$/i.test(
			path,
		) ||
		/(^|\/)(\.github\/workflows|\.azuredevops|\.devops|deploy|infra|infrastructure|terraform|helm|k8s|charts)\/.*\.(ya?ml|json|tf|ts|py|bicep)$/i.test(
			path,
		) ||
		/(^|\/)(Dockerfile[^/]*|compose[^/]*\.(ya?ml)|\.env\.example|\.env\.sample|azure-pipelines[^/]*\.(ya?ml)|\.gitlab-ci\.yml|package\.json|pom\.xml|Cargo\.toml|go\.mod|Makefile|[^/]+\.(tf|bicep))$/i.test(
			path,
		) ||
		/(^|\/)(openapi|swagger)(\.[a-z0-9-]+)?\.(json|ya?ml)$/i.test(path)
	);
}

function recordRepo(row: RepoRow): void {
	const branch = row.defaultBranchRef?.name;
	if (!branch) return;
	db.query(`INSERT INTO repos(name,branch,pushed_at,disk_kib) VALUES(?,?,?,?)
 ON CONFLICT(name) DO UPDATE SET branch=excluded.branch,pushed_at=excluded.pushed_at,disk_kib=excluded.disk_kib`).run(
		row.nameWithOwner,
		branch,
		row.pushedAt,
		row.diskUsage,
	);
}

async function inventory(): Promise<number> {
	const rows = JSON.parse(
		await run([
			"gh",
			"repo",
			"list",
			config.org,
			"--limit",
			"1000",
			"--json",
			"nameWithOwner,defaultBranchRef,pushedAt,diskUsage",
		]),
	) as RepoRow[];
	if (rows.length === 1000) throw new Error("inventory reached 1000-repo cap");
	db.transaction(() => rows.forEach(recordRepo))();
	return rows.length;
}

async function mirror(
	repo: string,
	branch: string,
): Promise<{ path: string; head: string }> {
	const name = repo.slice(config.org.length + 1);
	if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === "." || name === "..")
		throw new Error("invalid repository name");
	const path = join(config.mirrors, name);
	if (!existsSync(join(path, ".git"))) {
		await run(
			["gh", "repo", "clone", repo, path, "--", "--depth=1", "--single-branch"],
			100_000,
		);
	} else {
		await run(
			["git", "-C", path, "fetch", "--depth=1", "origin", branch],
			100_000,
		);
		await run(
			["git", "-C", path, "checkout", "--detach", "FETCH_HEAD"],
			100_000,
		);
	}
	const head = (
		await run(["git", "-C", path, "rev-parse", "HEAD"], 1000)
	).trim();
	return { path, head };
}

function treeFiles(raw: string): TreeEntry[] {
	const files: TreeEntry[] = [];
	for (const record of raw.split("\0")) {
		if (!record) continue;
		const separator = record.indexOf("\t");
		if (separator < 0) continue;
		const [mode, type, sha] = record.slice(0, separator).split(" ");
		const path = record.slice(separator + 1);
		if (type === "blob" && mode !== "120000" && indexable(path))
			files.push({ path, type, sha });
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function indexRepo(
	row: {
		name: string;
		branch: string;
		pushed_at: string | null;
		cursor_path: string;
		head_sha: string | null;
		target_pushed_at: string | null;
	},
	budget: number,
): Promise<number> {
	const repo = row.name;
	let head = row.head_sha;
	let path = join(config.mirrors, repo.slice(config.org.length + 1));
	if (!head || row.cursor_path === "") {
		const current = await mirror(repo, row.branch);
		head = current.head;
		path = current.path;
		db.query(
			"UPDATE repos SET head_sha=?,target_pushed_at=?,cursor_path='',last_attempt_at=?,last_error=NULL WHERE name=?",
		).run(head, row.pushed_at, Date.now(), repo);
	}
	const files = treeFiles(
		await run(["git", "-C", path, "ls-tree", "-r", "-z", head], 32_000_000),
	);
	let processed = 0;
	for (const file of files) {
		if (row.cursor_path && file.path.localeCompare(row.cursor_path) <= 0)
			continue;
		if (processed >= budget) break;
		const id = `github:${repo}:${file.path}`;
		const old = db.query("SELECT blob_sha FROM docs WHERE id=?").get(id) as {
			blob_sha: string;
		} | null;
		const body =
			old?.blob_sha === file.sha
				? null
				: await run(["git", "-C", path, "show", file.sha], 400_000);
		if (body !== null && Buffer.byteLength(body) > 262_144) {
			db.query("UPDATE repos SET cursor_path=? WHERE name=?").run(
				file.path,
				repo,
			);
			processed++;
			continue;
		}
		db.transaction(() => {
			if (body !== null) {
				db.query("DELETE FROM docs_fts WHERE id=?").run(id);
				db.query(`INSERT INTO docs(id,repo,path,blob_sha,head_sha,title,body,line_count,state,indexed_at,stale_reason,stale_at)
 VALUES(?,?,?,?,?,?,?,?, 'current',?,NULL,NULL)
 ON CONFLICT(id) DO UPDATE SET blob_sha=excluded.blob_sha,head_sha=excluded.head_sha,
 title=excluded.title,body=excluded.body,line_count=excluded.line_count,state='current',
 indexed_at=excluded.indexed_at,stale_reason=NULL,stale_at=NULL`).run(
					id,
					repo,
					file.path,
					file.sha,
					head,
					file.path,
					body,
					body.split("\n").length,
					Date.now(),
				);
				db.query("INSERT INTO docs_fts(id,title,body) VALUES(?,?,?)").run(
					id,
					file.path,
					body,
				);
			} else {
				db.query(
					"UPDATE docs SET head_sha=?,state='current',indexed_at=? WHERE id=?",
				).run(head, Date.now(), id);
			}
			db.query(
				"UPDATE repos SET cursor_path=?,last_error=NULL WHERE name=?",
			).run(file.path, repo);
		})();
		processed++;
	}
	const remaining = files.some(
		(x) =>
			x.path.localeCompare(
				(
					db.query("SELECT cursor_path FROM repos WHERE name=?").get(repo) as {
						cursor_path: string;
					}
				).cursor_path,
			) > 0,
	);
	if (!remaining) {
		db.transaction(() => {
			db.query(
				"UPDATE docs SET state='deleted',stale_at=? WHERE repo=? AND head_sha<>? AND state<>'deleted'",
			).run(Date.now(), repo, head);
			db.query(
				"UPDATE repos SET indexed_pushed_at=target_pushed_at,indexed_at=?,cursor_path='',last_error=NULL WHERE name=?",
			).run(Date.now(), repo);
		})();
	}
	return processed;
}

function status(): object {
	const repos = db
		.query(`SELECT count(*) total,
 sum(CASE WHEN indexed_at IS NOT NULL AND indexed_pushed_at IS pushed_at THEN 1 ELSE 0 END) current,
 sum(CASE WHEN cursor_path<>'' THEN 1 ELSE 0 END) in_progress,
 sum(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) errors FROM repos`)
		.get() as Record<string, number>;
	const docs = db
		.query(
			"SELECT count(*) total,sum(state='current') current,sum(state='suspect') suspect FROM docs",
		)
		.get();
	return {
		org: config.org,
		repos,
		docs,
		db: config.db,
		at: new Date().toISOString(),
	};
}

async function sync(): Promise<void> {
	const lock = `${config.db}.sync-lock`;
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch {
		if (Date.now() - statSync(lock).mtimeMs < 600_000) {
			console.log(
				JSON.stringify({ skipped: "sync already running", ...status() }),
			);
			return;
		}
		rmdirSync(lock);
		mkdirSync(lock, { mode: 0o700 });
	}
	try {
		const count = await inventory();
		let budget = Math.max(1, Math.min(1000, config.filesPerRun ?? 25));
		const rows = db
			.query(`SELECT name,branch,pushed_at,cursor_path,head_sha,target_pushed_at FROM repos
 WHERE indexed_at IS NULL OR indexed_pushed_at IS NOT pushed_at OR cursor_path<>''
 ORDER BY cursor_path='', indexed_at IS NOT NULL, COALESCE(last_attempt_at,0), name LIMIT ?`)
			.all(Math.max(1, Math.min(20, config.batch ?? 5))) as Array<{
			name: string;
			branch: string;
			pushed_at: string | null;
			cursor_path: string;
			head_sha: string | null;
			target_pushed_at: string | null;
		}>;
		let files = 0;
		for (const row of rows) {
			if (budget <= 0) break;
			try {
				const n = await indexRepo(row, budget);
				files += n;
				budget -= n;
			} catch (error) {
				db.query(
					"UPDATE repos SET last_error=?,last_attempt_at=? WHERE name=?",
				).run(String(error).slice(0, 300), Date.now(), row.name);
			}
		}
		console.log(
			JSON.stringify({ inventory: count, filesProcessed: files, ...status() }),
		);
	} finally {
		rmdirSync(lock);
	}
}

if (verb === "sync") await sync();
if (verb === "status") console.log(JSON.stringify(status()));
if (verb === "search") {
	const q = process.argv.slice(3).join(" ").trim();
	if (!q) throw new Error("search needs a query");
	const rows = db
		.query(`SELECT d.id,d.repo,d.path,d.head_sha,d.line_count,d.state,d.body,
 snippet(docs_fts,2,'[',']','...',20) excerpt
 FROM docs_fts JOIN docs d ON d.id=docs_fts.id WHERE docs_fts MATCH ?
 AND d.state='current' ORDER BY bm25(docs_fts,0,8,1) LIMIT 20`)
		.all(q) as Array<{
		id: string;
		repo: string;
		path: string;
		head_sha: string;
		line_count: number;
		state: string;
		body: string;
		excerpt: string;
	}>;
	const terms =
		q.match(/[A-Za-z0-9_./-]{3,}/g)?.map((term) => term.toLowerCase()) ?? [];
	console.log(
		JSON.stringify(
			rows.map(({ body, ...row }) => {
				const lines = body.split("\n");
				const found = lines.findIndex((line) =>
					terms.some((term) => line.toLowerCase().includes(term)),
				);
				const start = Math.max(1, found + 1);
				const end = Math.min(lines.length, start + 4);
				return {
					...row,
					line_start: start,
					line_end: end,
					url: `https://github.com/${row.repo}/blob/${row.head_sha}/${row.path}#L${start}-L${end}`,
				};
			}),
		),
	);
}
if (verb === "stale") {
	const [id, ...why] = process.argv.slice(3);
	if (!id || !why.length)
		throw new Error("stale needs knowledge ID and reason");
	const changed = db
		.query(
			"UPDATE docs SET state='suspect',stale_reason=?,stale_at=? WHERE id=? AND state='current'",
		)
		.run(why.join(" ").slice(0, 500), Date.now(), id).changes;
	console.log(JSON.stringify({ id, marked: changed === 1 }));
}
db.close();
