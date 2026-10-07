// Operator-pinned remote policy, evaluated where the developer's repo lives.
// No shell commands, absolute policy paths, unbounded reads or remote probes.
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Database } from "bun:sqlite";

type Condition = {
	exists?: string;
	existsAny?: string[];
	grep?: string;
	grepAny?: string[];
	pattern?: string;
	flags?: string;
};
type Row = {
	id: string;
	repoClass: string;
	detect?: Condition[];
	check: Condition[];
	missingQuestion: string;
	policySource: string;
};
type Hub = { url: string; keyFile: string; sha256: string };
const MAX_BYTES = 1024 * 1024;
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

function pathInRepo(root: string, path: string): string {
	if (typeof path !== "string" || isAbsolute(path) || path.includes("\0"))
		throw new Error("unsafe policy path");
	const target = resolve(root, path);
	const rel = relative(root, target);
	if (rel === ".." || rel.startsWith("../"))
		throw new Error("policy path leaves repo");
	let ancestor = target;
	while (!existsSync(ancestor) && ancestor !== root)
		ancestor = resolve(ancestor, "..");
	const resolved = relative(root, realpathSync(ancestor));
	if (resolved === ".." || resolved.startsWith("../"))
		throw new Error("policy symlink leaves repo");
	return target;
}

function boundedText(path: string): string | null {
	if (!existsSync(path) || !statSync(path).isFile()) return null;
	if (statSync(path).size > MAX_BYTES)
		throw new Error("policy file exceeds read limit; compliance unknown");
	const fd = openSync(path, "r");
	try {
		const bytes = Buffer.alloc(MAX_BYTES);
		return bytes
			.subarray(0, readSync(fd, bytes, 0, MAX_BYTES, 0))
			.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function condition(root: string, value: Condition): boolean {
	const keys = Object.keys(value);
	const kind = keys.filter((key) =>
		["exists", "existsAny", "grep", "grepAny"].includes(key),
	);
	if (
		kind.length !== 1 ||
		keys.some(
			(key) =>
				![
					"exists",
					"existsAny",
					"grep",
					"grepAny",
					"pattern",
					"flags",
				].includes(key),
		)
	)
		throw new Error("unsupported policy condition");
	const selected = kind[0];
	const raw = value[selected];
	const paths = selected.endsWith("Any") ? raw : [raw];
	if (!Array.isArray(paths) || !paths.length || paths.length > 100)
		throw new Error("invalid policy paths");
	const targets = paths.map((path) => pathInRepo(root, path));
	if (selected.startsWith("exists")) return targets.some(existsSync);
	if (
		typeof value.pattern !== "string" ||
		value.pattern.length > 1024 ||
		(value.flags && !/^[imsu]*$/.test(value.flags))
	)
		throw new Error("invalid policy pattern");
	const pattern = new RegExp(value.pattern, value.flags);
	return targets.some((path) => {
		const text = boundedText(path);
		return text !== null && pattern.test(text);
	});
}

export function evaluateSessionPolicy(repo: string, rows: unknown): Row[] {
	if (!Array.isArray(rows) || rows.length > 100)
		throw new Error("invalid policy rows");
	const root = realpathSync(repo);
	const gaps: Row[] = [];
	for (const row of rows as Row[]) {
		if (
			!row ||
			typeof row.id !== "string" ||
			!row.id ||
			typeof row.missingQuestion !== "string" ||
			!row.missingQuestion ||
			row.missingQuestion.length > 4000 ||
			typeof row.policySource !== "string" ||
			!Array.isArray(row.check) ||
			!row.check.length ||
			row.check.length > 100 ||
			(row.detect && (!Array.isArray(row.detect) || row.detect.length > 100))
		)
			throw new Error("invalid policy row");
		// Validate every condition before evaluation so inert rows cannot hide unsafe paths.
		const checks = [...(row.detect ?? []), ...row.check].map((item) =>
			condition(root, item),
		);
		const detected = checks.slice(0, row.detect?.length ?? 0).every(Boolean);
		if (detected && !checks.slice(row.detect?.length ?? 0).every(Boolean))
			gaps.push(row);
	}
	return gaps;
}

export function boundedPolicyEvaluation(
	repo: string,
	rows: unknown,
	timeoutMs = 1000,
): Promise<Row[]> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(
			new URL("./session-policy-worker.ts", import.meta.url).href,
		);
		const stop = () => {
			clearTimeout(timer);
			worker.terminate();
		};
		const timer = setTimeout(() => {
			worker.terminate();
			reject(new Error("policy evaluation timed out; compliance unknown"));
		}, timeoutMs);
		worker.onmessage = (event) => {
			stop();
			if (event.data.error) reject(new Error(event.data.error));
			else resolve(event.data.gaps);
		};
		worker.onerror = () => {
			stop();
			reject(new Error("policy worker failed; compliance unknown"));
		};
		worker.postMessage({ repo, rows });
	});
}

async function limitedJson(response: Response): Promise<unknown> {
	if (!response.ok || !response.body)
		throw new Error(`hub policy HTTP ${response.status}`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > MAX_BYTES) throw new Error("hub policy manifest too large");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Follow only registered, recently reporting ancestry inside the project. */
export function policyAuthority(
	db: Database,
	sid: string,
	project: string,
): string {
	const visited = new Set<string>();
	let current = sid;
	for (let depth = 0; depth < 16; depth++) {
		if (visited.has(current)) throw new Error("policy session ancestry cycle");
		visited.add(current);
		const row = db
			.query("SELECT project,parent_sid,state,hb FROM sessions WHERE sid=?")
			.get(current) as {
			project: string;
			parent_sid: string | null;
			state: string;
			hb: number;
		} | null;
		if (!row && current === sid) return sid;
		if (
			!row ||
			row.project !== project ||
			(current !== sid &&
				(row.state !== "RUNNING" ||
					!Number.isFinite(row.hb) ||
					Date.now() - row.hb > 15 * 60_000 ||
					row.hb > Date.now() + 30_000))
		)
			throw new Error(
				"policy parent is not a live registered session in this project",
			);
		if (!row.parent_sid) return current;
		current = row.parent_sid;
	}
	throw new Error("policy session ancestry exceeds limit");
}

export async function checkSessionPolicies(options: {
	db: Database;
	sid: string;
	project: string;
	repo: string;
	configPath?: string;
	fetchFn?: typeof fetch;
}): Promise<string[]> {
	const path =
		options.configPath ??
		join(process.env.HOME ?? "", ".config/klh/repo-policy.json");
	if (!existsSync(path)) return [];
	const notes: string[] = [];
	const config = JSON.parse(readFileSync(path, "utf8")) as {
		version: number;
		hubs: Hub[];
	};
	if (
		config.version !== 1 ||
		!Array.isArray(config.hubs) ||
		config.hubs.length > 10
	)
		throw new Error("invalid repo-policy config");
	for (const hub of config.hubs) {
		try {
			const url = new URL(hub.url);
			if (
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				url.pathname !== "/" ||
				(url.protocol !== "https:" &&
					!(
						url.protocol === "http:" &&
						["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
					))
			)
				throw new Error("hub policy requires HTTPS (loopback HTTP allowed)");
			if (!/^[a-f0-9]{64}$/.test(hub.sha256))
				throw new Error("policy content pin required");
			const keyStat = statSync(hub.keyFile);
			if (
				!keyStat.isFile() ||
				(keyStat.mode & 0o077) !== 0 ||
				keyStat.size > 4096
			)
				throw new Error("policy credential must be private bounded file");
			const key = readFileSync(hub.keyFile, "utf8").trim();
			if (!key || /[\r\n]/.test(key))
				throw new Error("invalid policy credential");
			const response = await (options.fetchFn ?? fetch)(
				new URL("/repo-policy/manifest", url),
				{
					headers: { authorization: `Bearer ${key}` },
					redirect: "error",
					signal: AbortSignal.timeout(3000),
				},
			);
			const manifest = (await limitedJson(response)) as {
				ok: boolean;
				version: number;
				sha256: string;
				rows: unknown;
			};
			if (
				!manifest.ok ||
				manifest.version !== 1 ||
				manifest.sha256 !== hub.sha256 ||
				digest(manifest.rows) !== hub.sha256
			)
				throw new Error("hub policy provenance/content pin mismatch");
			const gaps = await boundedPolicyEvaluation(options.repo, manifest.rows);
			const target = policyAuthority(options.db, options.sid, options.project);
			for (const gap of gaps) {
				const dedupe = `policy.session.${digest([target, options.project, hub.url, hub.sha256, gap.id])}`;
				const question = gap.missingQuestion;
				const eventId = options.db.transaction(() => {
					const prior = options.db
						.query("SELECT value FROM facts WHERE key = ?")
						.get(dedupe) as { value: string } | null;
					if (prior) {
						const id = Number(prior.value);
						if (!Number.isSafeInteger(id) || id <= 0)
							throw new Error("invalid shared policy decision reference");
						const event = options.db
							.query("SELECT kind,payload,target FROM events WHERE id=?")
							.get(id) as {
							kind: string;
							payload: string;
							target: string;
						} | null;
						const payload = event ? JSON.parse(event.payload) : null;
						if (
							event?.kind !== "NEED_DECISION" ||
							event.target !== target ||
							payload?.project !== options.project ||
							payload?.policy?.hub !== hub.url ||
							payload?.policy?.sha256 !== hub.sha256 ||
							payload?.policy?.id !== gap.id
						)
							throw new Error("shared policy decision provenance mismatch");
						return { id, created: false };
					}
					const result = options.db
						.query(
							"INSERT INTO events (ts,source,kind,payload,target) VALUES (?,?,'NEED_DECISION',?,?)",
						)
						.run(
							Date.now(),
							options.sid,
							JSON.stringify({
								project: options.project,
								note: `${question}\nPolicy provenance: ${hub.url} / ${gap.id} / ${gap.policySource} / sha256:${hub.sha256}`,
								policy: {
									hub: hub.url,
									sha256: hub.sha256,
									id: gap.id,
									source: gap.policySource,
								},
								options: ["Implement", "Later"],
							}),
							target,
						);
					const id = Number(result.lastInsertRowid);
					options.db
						.query("INSERT INTO facts (key,value,ts) VALUES (?,?,?)")
						.run(dedupe, String(id), Date.now());
					return { id, created: true };
				})();
				if (eventId.created)
					notes.push(
						`POLICY DECISION ${eventId.id}: ${question} [hub=${hub.url} row=${gap.id} sha256=${hub.sha256}] Ask for approval; do not implement without the owner's answer.`,
					);
				else if (target !== options.sid)
					notes.push(
						`POLICY REFERENCE ${eventId.id}: shared with parent ${target}; consult that decision before any remediation. [hub=${hub.url} row=${gap.id} sha256=${hub.sha256}] Do not ask a duplicate question.`,
					);
			}
		} catch (error) {
			notes.push(
				`POLICY CHECK UNAVAILABLE: ${hub.url} — ${error instanceof Error ? error.message : "failed"}; policy compliance is unknown.`,
			);
		}
	}
	return notes;
}
