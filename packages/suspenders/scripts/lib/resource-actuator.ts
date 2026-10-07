import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { processBirth, type ProcessBirth } from "./launch-fencing.ts";
import { descendant, identityMatches, parentPid } from "./owned-process.ts";
import type { ServiceVerdict } from "./service-drift.ts";

export interface ResourceTarget {
	label: string;
	pid: number;
	port: number;
	reason: string;
}
export interface ResourceAction {
	state: "signaled" | "held" | "failed";
	detail: string;
	receipt?: string;
}
export interface ActuatorDeps {
	owner: (label: string) => ServiceVerdict | undefined;
	birth: (pid: number) => ProcessBirth | false | null;
	parent: (pid: number) => number | null;
	listener: (pid: number, port: number) => boolean;
	kill: (pid: number) => void;
	now: () => number;
}
const listener = (pid: number, port: number): boolean => {
	const result = Bun.spawnSync(
		["/usr/sbin/lsof", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
		{ stdout: "pipe", stderr: "ignore" },
	);
	return (
		result.exitCode === 0 &&
		result.stdout.toString().trim().split(/\s+/).includes(String(pid))
	);
};
/** Reserve a durable per-service action before signaling; crashes consume budget. */
export function resourceAction(
	path: string,
	target: ResourceTarget,
	owner: ActuatorDeps["owner"],
	overrides: Partial<ActuatorDeps> = {},
): ResourceAction {
	const deps: ActuatorDeps = {
		owner,
		birth: processBirth,
		parent: parentPid,
		listener,
		kill: (pid) => process.kill(pid, "SIGKILL"),
		now: Date.now,
		...overrides,
	};
	const held = (detail: string): ResourceAction => ({ state: "held", detail });
	if (
		!Number.isSafeInteger(target.pid) ||
		target.pid <= 1 ||
		target.pid === process.pid
	)
		return held("unsafe target identity");
	const service = deps.owner(target.label);
	if (
		service?.state !== "running" ||
		!service.pid ||
		service.pid === target.pid
	)
		return held("UNKNOWN activated launchd ownership; no signal sent");
	const targetBirth = deps.birth(target.pid),
		ownerBirth = deps.birth(service.pid);
	if (
		!targetBirth ||
		!ownerBirth ||
		!deps.listener(target.pid, target.port) ||
		!descendant(target.pid, service.pid, deps.parent)
	)
		return held(
			"UNKNOWN listener/start identity/owned ancestry; no signal sent",
		);
	let db: Database | undefined;
	const receipt = crypto.randomUUID();
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		db = new Database(path);
		chmodSync(path, 0o600);
		db.exec(
			"PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,label TEXT NOT NULL,at INTEGER NOT NULL,pid INTEGER NOT NULL,birth TEXT NOT NULL,owner_pid INTEGER NOT NULL,owner_birth TEXT NOT NULL,reason TEXT NOT NULL,result TEXT NOT NULL)",
		);
		db.exec("BEGIN IMMEDIATE");
		const now = deps.now();
		const history = db
			.query(
				"SELECT COUNT(*) AS count,MAX(at) AS latest FROM actions WHERE label=? AND at>=?",
			)
			.get(target.label, now - 60 * 60_000) as {
			count: number;
			latest: number | null;
		};
		if (
			history.count >= 3 ||
			(history.latest !== null && now - history.latest < 5 * 60_000)
		) {
			db.exec("ROLLBACK");
			return held(
				"resource action budget/cooldown held; owner decision required",
			);
		}
		db.query("INSERT INTO actions VALUES(?,?,?,?,?,?,?,?,?)").run(
			receipt,
			target.label,
			now,
			target.pid,
			targetBirth.birth,
			service.pid,
			ownerBirth.birth,
			target.reason,
			"reserved",
		);
		db.exec("COMMIT"); // disk-backed intent precedes any irreversible signal
		const fresh = deps.owner(target.label);
		if (
			fresh?.state !== "running" ||
			fresh.pid !== service.pid ||
			!identityMatches(ownerBirth, deps.birth(service.pid)) ||
			!identityMatches(targetBirth, deps.birth(target.pid)) ||
			!deps.listener(target.pid, target.port) ||
			!descendant(target.pid, service.pid, deps.parent)
		) {
			db.query(
				"UPDATE actions SET result='held-identity-changed' WHERE id=?",
			).run(receipt);
			return {
				state: "held",
				detail:
					"ownership or exact process identity changed after reservation; no signal sent",
				receipt,
			};
		}
		deps.kill(target.pid);
		db.query("UPDATE actions SET result='signaled' WHERE id=?").run(receipt);
		return {
			state: "signaled",
			detail: `SIGKILL sent to owned listener :${target.port} pid ${target.pid}; recovery unverified`,
			receipt,
		};
	} catch {
		try {
			db?.query(
				"UPDATE actions SET result='failed-or-unconfirmed' WHERE id=? AND result='reserved'",
			).run(receipt);
		} catch {
			/* A durable reservation still holds the budget if result publication fails. */
		}
		return {
			state: "failed",
			detail:
				"resource action or durable receipt unavailable; inspect reservation before retry",
			receipt,
		};
	} finally {
		db?.close();
	}
}
