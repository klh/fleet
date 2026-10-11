#!/usr/bin/env bun
// hooks/bin/lifecycle-authority.ts — W576.7.1: the lifecycle-authority minter.
// The service-lifecycle fence (hooks/gates/lifecycle.ts) denies a lane's
// protected service lifecycle mutations (active launchd units, the activation
// receipt, direct launchctl bootout/bootstrap/load) without a matching grant
// row in governor.db. This is the SECOND-PERSON surface for that fence: the
// owner runs it from their own terminal — a lane that tries to self-grant is
// refused by the ppid walk (lib/fleetlane.ts), exactly like
// approve-destructive.ts.
//
//   bun ~/.claude/hooks/bin/lifecycle-authority.ts grant --sid <sid> \
//     --scope com.suspenders.board        # one label
//   bun ~/.claude/hooks/bin/lifecycle-authority.ts grant --sid <sid> --scope '*' [--minutes 30]
//   bun ~/.claude/hooks/bin/lifecycle-authority.ts revoke --sid <sid> [--scope <s>]
//   bun ~/.claude/hooks/bin/lifecycle-authority.ts list
//
// Grants are time-boxed (default 10 minutes), (sid, scope)-keyed, and audited
// in the events table. Machine-scoped on purpose: launchd domains are per-host.
import { resolveFleetLane } from "../lib/fleetlane.ts";
import { openGovernorDb } from "../lib/govdb.ts";
import {
	lifecycleGrantSchema,
	holdsLifecycleAuthority,
} from "../gates/lifecycle.ts";

// a lane cannot grant itself lifecycle authority — the owner is NOT a lane
const lane = resolveFleetLane(process.cwd());
if (lane) {
	console.error(
		`lifecycle-authority: refusing — this shell resolves as fleet lane ${lane.sid} (item ${lane.item}). The owner grants authority: run this from your own terminal, not inside a lane.`,
	);
	process.exit(1);
}

const argv = process.argv.slice(2);
const verb = argv[0] ?? "";
const flag = (name: string): string | null => {
	const i = argv.indexOf(name);
	if (i === -1) return null;
	const v = argv[i + 1];
	return !v || v.startsWith("--") ? null : v;
};

const SCOPE_RE = /^\*$|^[a-z0-9.-]+$/;
const MINUTES = 10;

const db = openGovernorDb();
lifecycleGrantSchema(db);

if (verb === "grant") {
	const sid = flag("--sid");
	const scope = flag("--scope");
	if (!sid || !scope || !SCOPE_RE.test(scope)) {
		console.error(
			"usage: lifecycle-authority.ts grant --sid <lane-sid> --scope <com.suspenders.<label>|*|label> [--minutes <n>]  (default 10 minutes)",
		);
		process.exit(2);
	}
	const minutes = Number(flag("--minutes") ?? MINUTES);
	if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
		console.error("lifecycle-authority: --minutes must be 1..1440");
		process.exit(2);
	}
	db.run(
		"INSERT INTO service_lifecycle_grants(sid,scope,nonce,granted_by,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(sid,scope) DO UPDATE SET nonce=excluded.nonce,granted_by='owner',expires_at=excluded.expires_at",
		[sid, scope, crypto.randomUUID(), "owner", Date.now() + minutes * 60_000],
	);
	db.run(
		"INSERT INTO events(ts,source,kind,scope,payload) VALUES (?,?,?,?,?)",
		[
			Date.now(),
			"owner",
			"service-lifecycle.grant",
			scope,
			JSON.stringify({ op: "grant", sid, scope, minutes }),
		],
	);
	console.log(
		`lifecycle-authority: ${sid} may now run protected ${scope === "*" ? "lifecycle operations (any scope)" : `lifecycle operations on ${scope}`} for ${minutes}m (audited; the fence audits each use).`,
	);
} else if (verb === "revoke") {
	const sid = flag("--sid");
	if (!sid) {
		console.error(
			"usage: lifecycle-authority.ts revoke --sid <lane-sid> [--scope <s>]",
		);
		process.exit(2);
	}
	const scope = flag("--scope");
	const changed = scope
		? db.run("DELETE FROM service_lifecycle_grants WHERE sid=? AND scope=?", [
				sid,
				scope,
			]).changes
		: db.run("DELETE FROM service_lifecycle_grants WHERE sid=?", [sid]).changes;
	db.run(
		"INSERT INTO events(ts,source,kind,scope,payload) VALUES (?,?,?,?,?)",
		[
			Date.now(),
			"owner",
			"service-lifecycle.grant",
			scope ?? "",
			JSON.stringify({
				op: "revoke",
				sid,
				scope: scope ?? "*",
				removed: changed,
			}),
		],
	);
	console.log(
		changed > 0
			? `lifecycle-authority: revoked ${changed} grant(s) for ${sid}${scope ? ` scope ${scope}` : ""}.`
			: `lifecycle-authority: no live grant matched ${sid}${scope ? ` scope ${scope}` : ""} (nothing changed).`,
	);
} else if (verb === "list") {
	const rows = db
		.query(
			"SELECT sid,scope,granted_by,expires_at FROM service_lifecycle_grants ORDER BY expires_at",
		)
		.all() as Array<{
		sid: string;
		scope: string;
		granted_by: string;
		expires_at: number;
	}>;
	if (rows.length === 0) {
		console.log("lifecycle-authority: no grants.");
	} else {
		for (const r of rows)
			console.log(
				`${r.sid}  ${r.scope}  by ${r.granted_by}  ${
					r.expires_at > Date.now()
						? `live ${Math.round((r.expires_at - Date.now()) / 60_000)}m`
						: "EXPIRED"
				}`,
			);
	}
} else {
	console.error(
		"usage: lifecycle-authority.ts <grant|revoke|list> [flags]  — grant --sid <sid> --scope <com.suspenders.<label>|*> [--minutes <n>]",
	);
	db.close();
	process.exit(2);
}
const sid = argv.includes("--sid") ? (flag("--sid") ?? "") : "";
if (
	verb === "grant" &&
	sid &&
	holdsLifecycleAuthority(db, sid, flag("--scope") ?? "*")
)
	console.log(
		"  verified: the fence now admits the granted scope for this sid.",
	);
db.close();
