// e2e/contrastive-helpers.ts — W2184: helpers for the W927 contrastive
// consult e2e spec. Plain node APIs so the spec runs under any playwright
// runtime; store reads ride `bun -e` (bun:sqlite lives in the bun runtime).
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const HOME = mkdtempSync(join(tmpdir(), "suspenders-cv2-"));
export const REPO = mkdtempSync(join(tmpdir(), "suspenders-cv2-repo-"));
mkdirSync(join(REPO, ".git", "hooks"), { recursive: true });
mkdirSync(join(HOME, ".cache", "claude-governor"), { recursive: true });

export const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
export const DB = join(HOME, ".cache", "claude-governor", "governor.db");
// pin every operator knob the legs read — ambient env must not leak in
export const BASE_ENV: Record<string, string> = {
	SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
	ORACLE_ROUTE_MODEL: "",
	CONTRASTIVE_CODER_MODEL: "",
	CONTRASTIVE_DANISH_MODEL: "",
};

// a sqlite read from the playwright runtime: `bun -e` opens bun:sqlite in
// the bun child and prints JSON rows
export async function sqlJson(sql: string, ...params: unknown[]) {
	const code =
		'const {Database}=require("bun:sqlite");' +
		`const db=new Database(${JSON.stringify(DB)});` +
		`console.log(JSON.stringify(db.query(${JSON.stringify(sql)}).all(...${JSON.stringify(params)})));`;
	const r = await execFileP("bun", ["-e", code]);
	return JSON.parse(r.stdout);
}

// a single-row sqlite read (undefined when absent)
export async function sqlGet(sql: string, ...params: unknown[]) {
	const rows = await sqlJson(sql, ...params);
	return rows[0];
}

export function cleanup(): void {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
}

export let PROJ = "";
export async function initProject(): Promise<string> {
	let gitdir = "";
	try {
		const d = await execFileP("git", [
			"-C",
			REPO,
			"rev-parse",
			"--git-common-dir",
		]);
		gitdir = d.stdout.trim();
	} catch {
		gitdir = "";
	}
	PROJ = gitdir ? realpathSync(resolve(REPO, gitdir)) : realpathSync(REPO);
	return PROJ;
}

// the anthropic-wire stub server — buckleChat POSTs /v1/messages against it.
// failHint: respond 500 to every request whose x-belt-hint matches — the
// per-leg failure lever (pool legs share one gated front).
export function makeStub(script, failHint) {
	let n = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			if (
				failHint &&
				String(req.headers["x-belt-hint"] ?? "").includes(failHint)
			) {
				res.statusCode = 500;
				res.end(JSON.stringify({ error: "leg down" }));
				return;
			}
			const content = script[n] ?? "stub overflow answer";
			n++;
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					model: "stub-model",
					content: [{ type: "text", text: content }],
					usage: { input_tokens: 10, output_tokens: 20 },
					stop_reason: "end_turn",
				}),
			);
		});
	});
	return new Promise((done) => {
		server.listen(0, "127.0.0.1", () => {
			done({
				url: `http://127.0.0.1:${server.address().port}/`,
				stop: () => server.close(),
			});
		});
	});
}

// async spawn of the real coord CLI (a stub server can't answer spawnSync);
// node streams collected to strings. consult/consult-reply ride an explicit
// --version so trust verification has a stable code-version pin.
export async function run(args, extraEnv = {}) {
	const env = { ...process.env, HOME, ...BASE_ENV, ...extraEnv };
	const versionArgs =
		args[0] === "consult"
			? ["--version", "test-version", "--scope", "hooks/leases"]
			: args[0] === "consult-reply"
				? ["--version", "test-version"]
				: [];
	const p = spawn("bun", [coord, ...args, ...versionArgs], {
		cwd: REPO,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	let err = "";
	p.stdout.on("data", (c) => (out += c));
	p.stderr.on("data", (c) => (err += c));
	const code = await new Promise((res) => p.on("exit", res));
	return { out, err, code };
}

export async function seedSession(sid: string) {
	await sqlJson(
		"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')",
		sid,
		PROJ,
		Date.now(),
		Date.now(),
	);
}
