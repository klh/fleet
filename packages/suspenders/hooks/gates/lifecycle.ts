// hooks/gates/lifecycle.ts — W576.7.1: the service-lifecycle fence. A
// governed lane cannot alter the protected service lifecycle state — active
// launchd units (~/Library/LaunchAgents/com.suspenders.*.plist, legacy
// com.klh.*) or the activation receipt (~/.config/klh/service-activation.json)
// — and cannot invoke direct service bootout/bootstrap/load — through ANY
// program text the command runs (bun/node/deno/python/shell script files and
// inline -e/-c payloads), without matching lifecycle authority. The fence is
// a harness-level lead-scan over program text, NOT an OS sandbox: dynamically
// composed paths or self-modifying payloads can evade it; the supported path
// for lifecycle work remains the owner-run installer.
//
// Authority: a time-boxed grant row in governor.db (service_lifecycle_grants,
// the same store as the W576.3 lease fence), minted by the OWNER from their
// own terminal via hooks/bin/lifecycle-authority.ts. Owner-class sessions
// (no fleet lane ancestry) are exempt — the established gate semantic shared
// with two-person/hardening/credscope. Typed refusals: missing grant, expired
// grant, grant-scope mismatch on the targeted label, and an unopenable
// authority store. A granted direct launchctl stands down the W250 two-person
// launchctl family for the same command — the grant IS the second opinion.
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolveFleetLane } from "../lib/fleetlane.ts";
import { openStore, type GovernorStore } from "../lib/govdb.ts";
import { deny } from "../lib/hookio.ts";

// ─── protected surface ───────────────────────────────────────────────────────

// Namespaced fleet service units (the labels install-launchd.ts renders and
// the receipt pins) plus the legacy com.klh.* set.
const UNIT_LABEL = /^(?:com\.suspenders|com\.klh)\.[a-z0-9-]+$/;

/** The protected-path signal a program-text line carries: a fleet service
 * unit path (directory + label + .plist) or the activation receipt. */
export function protectedPathSignal(line: string): boolean {
	if (/service-activation\.json/.test(line)) return true;
	return (
		/LaunchAgents/.test(line) && /\.plist\b/.test(line) && UNIT_PART.test(line)
	);
}
const UNIT_PART = /com\.(?:suspenders|klh)\./;

/** Does `path` name a protected lifecycle file (absolute form)? */
export function protectedPathHit(path: string): string | null {
	const home = process.env.HOME ?? "";
	const inHome = path.startsWith(`${home}/`) ? path.slice(home.length + 1) : "";
	if (inHome === "Library/LaunchAgents") return "the LaunchAgents directory";
	if (inHome.startsWith("Library/LaunchAgents/")) {
		const base = basename(path);
		if (!base.endsWith(".plist")) return null;
		return UNIT_LABEL.test(base.replace(/\.plist$/, ""))
			? "an active launchd unit"
			: null;
	}
	if (inHome === ".config/klh/service-activation.json")
		return "the service activation receipt";
	return null;
}

// ─── detection ───────────────────────────────────────────────────────────────

// launchctl lifecycle verbs: registration and its destructive mirror. print/
// list/procs/etc. stay free — read-only inspection is legitimate fleet work.
export const LAUNCHCTL_MUTATIONS = new Set([
	"bootstrap",
	"bootout",
	"load",
	"unload",
	"enable",
	"disable",
	"remove",
	"kickstart",
]);

/** Direct `launchctl <mutation>` in a verb-normalized segment → the targeted
 * label (from a .plist argument), else wildcard. */
export function launchctlMutationHit(
	w: string[],
): { label: string | null } | null {
	if (w[0] !== "launchctl") return null;
	const sub = w[1];
	if (!sub || !LAUNCHCTL_MUTATIONS.has(sub)) return null;
	for (let i = 2; i < w.length; i++) {
		const a = w[i];
		if (a.startsWith("<op")) continue;
		if (a.endsWith(".plist")) {
			const label = basename(a, ".plist");
			return { label: UNIT_LABEL.test(label) ? label : null };
		}
	}
	return { label: null };
}

// write-capable APIs whose arguments name the protected target. Read-only
// inspection (readFileSync, plutil -convert, launchctl print) never hits —
// the W576.7 read-only watchdog posture must keep working.
const WRITE_APIS =
	/writeFileSync|copyFileSync|appendFileSync|renameSync|cpSync|rmSync|unlinkSync|truncateSync|chmodSync|chownSync|linkSync|symlinkSync|Bun\.write\b|shutil\.(?:copy2?|copyfile|copytree|move|rmtree)|os\.(?:remove|unlink|rename|replace|truncate)|\.write_(?:text|bytes)\(|plistlib\.dump|open\s*\([^)]*['"][wax]/;

/** Program-text scan: shell files pair per-line launchctl mutations (a
 * call/array shape, or the shell redirect/copy family) ; JS/TS/Python pair a
 * write-API with a protected path on one line. launchctl-as-data (board
 * recovery maps, deny-list assertions, strings) is prose, not execution — and
 * test files carry assertion strings by design, so launchctl-only hits never
 * fire inside test paths. */
export function programLifecycleHit(
	text: string,
	isTestFile: boolean,
): { what: string; kind: "unit-write" | "launchctl" } | null {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line.includes("launchctl")) continue;
		const m =
			/launchctl[^a-z]*(bootstrap|bootout|load|unload|enable|disable|remove|kickstart)/.exec(
				line,
			);
		if (!m) continue;
		const callShape =
			/(?:spawn(?:Sync)?\s*\(|execa\s*\(|exec(?:Sync)?\s*\(|\[\s*["'`]launchctl)/.test(
				line,
			) || /^launchctl\b/.test(line); // shell command position (the loader)
		const shellWrite = /(?:^|[^\\])>\s*\S|\b(?:cp|mv|tee|rm)\s+\S/.test(line);
		if (callShape && !isTestFile)
			return { what: line.slice(0, 120), kind: "launchctl" };
		if (shellWrite && protectedPathSignal(line))
			return { what: line.slice(0, 120), kind: "launchctl" };
	}
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (WRITE_APIS.test(line) && protectedPathSignal(line))
			return { what: line.slice(0, 120), kind: "unit-write" };
	}
	return null;
}

// interpreters whose file/inline payloads the fence interprets
const INTERPRETERS = new Set([
	"bun",
	"node",
	"deno",
	"python3",
	"python",
	"sh",
	"bash",
	"zsh",
]);
const INLINE_CODE_FLAGS = new Set(["-e", "--eval", "-c"]);
const PAYLOAD_CAP = 1024 * 1024; // larger files are unscannable, never a hit

const isTestPath = (p: string): boolean =>
	/(?:^|\/)(?:test|tests|spec|__tests__)(?:\/|$)/.test(p) ||
	/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(basename(p));

type Payload = { source: string; text: string; isTestFile: boolean };

/** Every program payload (file argument or inline code string) a segment
 * carries, resolved against the segment cwd. Non-existent file arguments are
 * skipped (the runtime prints its own ENOENT). */
export function programPayloads(w: string[], segCwd: string): Payload[] {
	const out: Payload[] = [];
	const vi = w.findIndex((t) => !t.startsWith("<op"));
	for (let i = vi + 1; i < w.length; i++) {
		const a = w[i];
		if (a.startsWith("<op") || a.startsWith("-")) continue;
		if (INLINE_CODE_FLAGS.has(a)) {
			const code = w[i + 1];
			if (code && !code.startsWith("<op"))
				out.push({ source: `inline ${a}`, text: code, isTestFile: false });
			continue;
		}
		const looksFile = a.includes("/") || /\.(?:ts|js|mjs|cjs|py|sh)$/.test(a);
		if (!looksFile) continue;
		const p = a.startsWith("/") ? a : resolve(segCwd, a);
		try {
			const st = statSync(p);
			if (!st.isFile() || st.size > PAYLOAD_CAP) continue;
			out.push({
				source: p,
				text: readFileSync(p, "utf8"),
				isTestFile: isTestPath(p),
			});
		} catch {
			/* unreadable/missing: no payload */
		}
	}
	return out;
}

// ─── authority ───────────────────────────────────────────────────────────────

export const lifecycleGrantSchema = (db: {
	run: (sql: string) => unknown;
}): void => {
	db.run(
		"CREATE TABLE IF NOT EXISTS service_lifecycle_grants(sid TEXT NOT NULL,scope TEXT NOT NULL,nonce TEXT NOT NULL,granted_by TEXT NOT NULL DEFAULT 'owner',expires_at INTEGER NOT NULL,PRIMARY KEY(sid,scope))",
	);
};

/** A grant matches when unexpired and scoped to the label or the wildcard. */
export function holdsLifecycleAuthority(
	db: { query: (sql: string) => { get: (...p: unknown[]) => unknown } },
	sid: string,
	scope: string,
): boolean {
	lifecycleGrantSchema(db);
	const hit = db
		.query(
			"SELECT 1 FROM service_lifecycle_grants WHERE sid=? AND expires_at>? AND (scope='*' OR scope=?) LIMIT 1",
		)
		.get(sid, Date.now(), scope);
	return !!hit;
}

/** Best-effort audit row; an audit failure never gates the decision. */
export function auditLifecycle(
	db: { run: (sql: string, ...p: unknown[]) => unknown } | null,
	entry: Record<string, unknown>,
): void {
	try {
		db?.run(
			"INSERT INTO events(ts,source,kind,scope,payload) VALUES (?,?,?,?,?)",
			Date.now(),
			String(entry.sid ?? "unknown"),
			"service-lifecycle",
			String(entry.scope ?? ""),
			JSON.stringify(entry),
		);
	} catch {
		/* audit is advisory */
	}
}

// ─── the gate section ────────────────────────────────────────────────────────

const authorityRefusal = (sid: string, what: string): string =>
	`lifecycle-fence: ${what} is a protected service lifecycle operation. Lane ${sid} holds no matching lifecycle authority. The owner grants it from their own terminal: bun ~/.claude/hooks/bin/lifecycle-authority.ts grant --sid ${sid} --scope <com.suspenders.<label>|*> — or runs the supported installer (install.sh) themselves. Read-only inspection stays free; this fence is a harness lead-scan, not an OS sandbox.`;

/** W576.7.1 fence: deny a lane's lifecycle mutations without a matching
 * grant; audit and allow-through when granted. Returns whether a granted
 * lifecycle operation is present (the two-person launchctl family stands
 * down for the command). Owner sessions: false, never deny. */
export function lifecycleGate(SEGS: string[][], CWD: string): boolean {
	// cheap signal phase first: the lane walk (ppid ps-spawns) and the
	// authority read only run once a mutation signal exists.
	const signal =
		SEGS.some((w) => launchctlMutationHit(w) !== null) ||
		SEGS.some(
			(w) => INTERPRETERS.has(w[0]) && programPayloads(w, CWD).length > 0,
		);
	if (!signal) return false;
	const lane = resolveFleetLane(CWD);
	if (!lane) return false; // owner-class session — the established exemption

	let db: GovernorStore | null = null;
	try {
		db = openStore();
	} catch {
		db = null; // store outage → fail-closed below (typed refusal)
	}

	let approved = false;
	for (const w of SEGS) {
		const hit = launchctlMutationHit(w);
		if (!hit) continue;
		const scope = hit.label ?? "*";
		if (!db || !holdsLifecycleAuthority(db, lane.sid, scope)) {
			auditLifecycle(db, {
				decision: "deny",
				sid: lane.sid,
				scope,
				op: `launchctl ${w[1]}`,
			});
			deny(
				authorityRefusal(
					lane.sid,
					`direct launchctl ${w[1]}${scope === "*" ? "" : ` of ${scope}`}`,
				),
			);
		}
		auditLifecycle(db, {
			decision: "allow",
			sid: lane.sid,
			scope,
			op: `launchctl ${w[1]}`,
		});
		approved = true;
	}

	// program payloads: file/inline scans, cd-aware per segment
	let segCwd = CWD;
	for (const w of SEGS) {
		if (w[0] === "cd" && w[1] && !w[1].startsWith("<op")) {
			segCwd = w[1].startsWith("/") ? w[1] : resolve(segCwd, w[1]);
			continue;
		}
		if (!INTERPRETERS.has(w[0])) continue;
		for (const payload of programPayloads(w, segCwd)) {
			const hit = programLifecycleHit(payload.text, payload.isTestFile);
			if (!hit) continue;
			if (!db || !holdsLifecycleAuthority(db, lane.sid, "*")) {
				auditLifecycle(db, {
					decision: "deny",
					sid: lane.sid,
					scope: "*",
					op: `${payload.source}: ${hit.what}`,
				});
				deny(
					authorityRefusal(
						lane.sid,
						`${payload.source} ${hit.kind === "launchctl" ? "invokes" : "writes"} protected lifecycle state (${hit.what})`,
					),
				);
			}
			auditLifecycle(db, {
				decision: "allow",
				sid: lane.sid,
				scope: "*",
				op: `${payload.source}: ${hit.what}`,
			});
			approved = true;
		}
	}
	return approved;
}
