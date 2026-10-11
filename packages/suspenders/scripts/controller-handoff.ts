#!/usr/bin/env bun
// controller-handoff.ts — W576.5 owner-invoked controller handoff. Requests
// a fleet-loop watch to release single-authority at its next idle cycle
// boundary (launchd KeepAlive respawns it; lanes are separate processes,
// never touched), observes the handoff state machine, and verifies the
// successor actually runs the intended immutable generation. The fence
// itself lives in scripts/lib/controller-fence.ts; the old controller only
// ever acts on a request written here — no signals, no kills, no restarts.
//
//   bun scripts/controller-handoff.ts status   [--repo <dir>] [--prefix <dir>]
//   bun scripts/controller-handoff.ts request  [--repo <dir>] [--prefix <dir>]
//                                              [--generation <sha>] [--root <path>]
//   bun scripts/controller-handoff.ts cancel   [--repo <dir>]
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { openStore, projectIdentity } from "../hooks/lib/govdb.ts";
import {
	cancelControllerHandoff,
	controllerGeneration,
	controllerHolderLiveness,
	observeControllerLease,
	peekControllerHandoff,
	requestControllerHandoff,
} from "./lib/controller-fence.ts";

const args = process.argv.slice(2);
const verb = args[0] ?? "status";
if (!["status", "request", "cancel"].includes(verb)) {
	console.error(
		"usage: controller-handoff.ts status|request|cancel [--repo <dir>] [--prefix <dir>] [--generation <sha>] [--root <path>]",
	);
	process.exit(1);
}
const value = (flag: string): string | undefined => {
	const at = args.indexOf(flag);
	return at >= 0 ? args[at + 1] : undefined;
};
const repo = realpathSync(value("--repo") ?? process.cwd());
const prefix = realpathSync(
	value("--prefix") ??
		process.env.SUSPENDERS_PREFIX ??
		join(process.env.HOME ?? "", ".claude/hooks/suspenders"),
);
// same conflation guard as the activation registrar: the work repo the loop
// operates on must stay outside the immutable policy-code root.
if (repo === prefix || repo.startsWith(`${prefix}/`))
	throw new Error(
		"work repo must be distinct from the immutable policy-code root",
	);
const store = openStore();
const project = projectIdentity(repo);
try {
	if (verb === "request") {
		const lease = observeControllerLease(store, project);
		const root = realpathSync(value("--root") ?? prefix);
		const entry = join(root, "bin/fleet-loop.ts");
		const target = value("--generation") ?? controllerGeneration(entry);
		requestControllerHandoff(store, project, {
			fromNonce: lease?.nonce,
			targetGeneration: target,
			targetRoot: root,
		});
		console.log(
			`handoff requested: project=${project} from=${lease?.nonce ?? "(next starter)"} target_generation=${target}`,
		);
	} else if (verb === "cancel") {
		console.log(
			cancelControllerHandoff(store, project)
				? "handoff request cancelled"
				: "no pending handoff request",
		);
	} else {
		const lease = observeControllerLease(store, project);
		const handoff = peekControllerHandoff(store, project);
		if (lease) {
			const liveness = controllerHolderLiveness(lease);
			console.log(
				`lease: holder=${lease.nonce} pid=${lease.pid} host=${lease.host} generation=${lease.generation} liveness=${liveness} renewed=${new Date(lease.renewed_at).toISOString()}`,
			);
		} else console.log("lease: none (no acting controller)");
		if (handoff) {
			const verified =
				handoff.state === "assumed"
					? handoff.assumed_generation === handoff.target_generation &&
						handoff.assumed_generation !== null
					: null;
			console.log(
				`handoff: state=${handoff.state} target_generation=${handoff.target_generation} target_root=${handoff.target_root} assumed_generation=${handoff.assumed_generation ?? "-"} assumed_pid=${handoff.assumed_pid ?? "-"} verified=${verified ?? "n/a"}`,
			);
		} else console.log("handoff: none");
		console.log(
			`handoff status project=${project} state=${handoff?.state ?? "none"} verified=${handoff?.state === "assumed" ? String(handoff.assumed_generation === handoff.target_generation) : "n/a"}`,
		);
	}
} finally {
	store.close();
}
