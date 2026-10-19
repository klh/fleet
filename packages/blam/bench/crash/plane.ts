// packages/blam/bench/crash/plane.ts — the scripted control plane under
// test (v0 reference adapter): real git fixture state (refs, MERGE_HEAD,
// staged content) + policy-model eras. pre = 2026-09-28 incident behavior
// (registry-as-sole-truth sweep, kill(pid,0) liveness, abort-only recovery,
// bare commits allowed); post = the current guard set (act-time ground-truth
// revalidation, pid+argv identity liveness, heal-first recovery preserving
// debris to a ref, foreign-commit gate). Spec: bench/crash/scenario.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Fixture,
	RUNNER_CMD,
	stagedFiles,
	branchExists,
	writeMergeMarker,
	readMergeMarker,
	removeMergeMarker,
	clearMergeState,
} from "./fixture.ts";
import {
	type ControlPlane,
	type Era,
	type PlaneEvent,
	type PlaneEventKind,
	type PlaneReport,
	REGISTRY_LAG_TICKS,
	type Standin,
} from "./types.ts";

/** A lane marker on disk (real layout: .fleet/lanes/<sid>.json). */
interface LaneMarker {
	sid: string;
	branch: string;
	pid: number;
	cmd: string;
}

/** The scripted registry (external store with lag). */
interface RegistryEntry {
	branch: string;
	at: number;
}

const FIRST_PID = 7000;

export class ScriptedControlPlane implements ControlPlane {
	readonly era: Era;
	#fx: Fixture | null = null;
	#tick = 0;
	#pid = FIRST_PID;
	#registry = new Map<string, number>();
	#pendingRegistry: RegistryEntry[] = [];
	#pendingMerges: string[] = [];
	#failed = new Set<string>();
	#recoverFails = 0;
	#events: PlaneEvent[] = [];
	/** Scripted injection fired between the sweep's check and its act —
	 * C3 is DEFINED by that interleave, so the window is explicit. */
	midSweepHook: (() => void) | null = null;

	constructor(era: Era) {
		this.era = era;
	}

	init(fixtureRepo: string): void {
		if (this.#fx === null || this.#fx.repo !== fixtureRepo) {
			throw new Error(`init: unknown fixture ${fixtureRepo}`);
		}
		this.#tick = 0;
	}

	#fx1(): Fixture {
		if (this.#fx === null) throw new Error("plane not on a fixture");
		return this.#fx;
	}

	#event(kind: PlaneEventKind, subject: string): void {
		this.#events.push({ tick: this.#tick, kind, subject });
	}

	/** Scripted world edits (markers, procs) outside the lane contract. */
	get world(): Fixture {
		return this.#fx1();
	}

	get tick(): number {
		return this.#tick;
	}

	get events(): PlaneEvent[] {
		return [...this.#events];
	}

	/** Attach the plane to a fixture (README init(fixtureRepo)). */
	attach(fx: Fixture): void {
		this.#fx = fx;
		this.#tick = 0;
	}

	dispatchLane(item: { branch: string; sid: string }): Standin {
		const fx = this.#fx1();
		fx.git(["branch", item.branch, fx.base]);
		const pid = this.#pid++;
		const cmd = `bun run lane-agent --sid ${item.sid}`;
		fx.procs.set(pid, { pid, cmd, alive: true });
		writeFileSync(
			join(fx.fleet, "lanes", `${item.sid}.json`),
			JSON.stringify({ sid: item.sid, branch: item.branch, pid, cmd } satisfies LaneMarker),
		);
		this.#pendingRegistry.push({ branch: item.branch, at: this.#tick + REGISTRY_LAG_TICKS });
		const procs = fx.procs;
		return { pid, cmd, kill: () => { const row = procs.get(pid); if (row) row.alive = false; } };
	}

	/** The park mechanic: rename + drop the registry entry (S3). */
	parkRename(from: string, to: string): void {
		const fx = this.#fx1();
		fx.git(["branch", "-m", from, to]);
		this.#registry.delete(from);
		const i = this.#pendingRegistry.findIndex((r) => r.branch === from);
		if (i >= 0) this.#pendingRegistry.splice(i, 1);
	}

	queueMerge(branch: string): void {
		this.#pendingMerges.push(branch);
	}

	/** A live merge-runner stand-in the scenario seeds directly (S5). */
	seedRunner(pid: number): void {
		this.#fx1().procs.set(pid, { pid, cmd: RUNNER_CMD, alive: true });
	}

	/** The marker owner concludes its merge (S5 control leg). */
	runnerFinish(pid: number): void {
		const fx = this.#fx1();
		const staged = stagedFiles(fx);
		if (staged.length > 0) fx.git(["commit", "-q", "-m", `merge concluded by ${pid}`]);
		removeMergeMarker(fx);
	}

	/** A lane's scripted commit step, through the plane's commit gate. */
	laneCommit(
		actor: { pid: number },
		file: string,
		content: string,
		msg: string,
	): "landed" | "refused" {
		const fx = this.#fx1();
		const markerBefore = readMergeMarker(fx);
		if (this.era === "post" && markerBefore !== null && markerBefore.pid !== actor.pid) {
			this.#event("commit-refused", file);
			return "refused";
		}
		const concluding = fx.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok;
		writeFileSync(join(fx.repo, file), content);
		fx.git(["add", file]);
		fx.git(["commit", "-q", "-m", msg]);
		const kind: PlaneEventKind = concluding && markerBefore !== null
			? "commit-foreign"
			: "commit-landed";
		this.#event(kind, file);
		return "landed";
	}

	sweepCycle(): void {
		this.#tick++;
		const fx = this.#fx1();
		// registry catches up (the lag is environmental, both eras)
		for (const r of [...this.#pendingRegistry]) {
			if (r.at <= this.#tick) {
				this.#registry.set(r.branch, r.at);
				this.#pendingRegistry.splice(this.#pendingRegistry.indexOf(r), 1);
			}
		}
		this.#ladderCycle(fx);
		this.#retireCycle(fx);
	}

	#runnerLooksAlive(fx: Fixture, marker: { pid: number; cmd: string }): boolean {
		const row = fx.procs.get(marker.pid);
		if (!row?.alive) return false;
		return this.era === "pre" ? true : row.cmd === marker.cmd;
	}

	#ladderCycle(fx: Fixture): void {
		const marker = readMergeMarker(fx);
		if (marker === null) {
			this.#runMerges(fx);
			return;
		}
		if (this.#runnerLooksAlive(fx, marker)) {
			if (inMergeState(fx)) this.#event("heal-deferred", "merge-active");
			return;
		}
		const debris = mergeDebrisBranch(fx);
		if (inMergeState(fx)) {
			if (this.era === "pre") {
				this.#recoverFails++;
				this.#event("recovery-failed", debris);
				// R1: the recovery command cannot clear the debris; the
				// stalled ladder blames the queued next branch (S2 poison)
				const next = this.#pendingMerges.find((b) => !this.#failed.has(b));
				if (next !== undefined) {
					this.#failed.add(next);
					this.#event("branch-failed", next);
				}
				if (this.#recoverFails >= 2) this.#forcePrune(fx, debris);
				return;
			}
			this.#heal(fx, debris);
		} else {
			removeMergeMarker(fx);
		}
		this.#runMerges(fx);
	}

	#forcePrune(fx: Fixture, debris: string): void {
		if (branchExists(fx, debris)) fx.git(["branch", "-D", debris]);
		clearMergeState(fx);
		removeMergeMarker(fx);
		this.#event("force-prune", debris);
	}

	/** Heal-first recovery: preserve the staged debris to a ref, then
	 * clear the merge state — no content becomes unreachable. */
	#heal(fx: Fixture, debris: string): void {
		if (stagedFiles(fx).length > 0) {
			const tree = fx.git(["write-tree"]).out.trim();
			const sha = fx.git(["commit-tree", tree, "-p", "HEAD", "-m", `blam: preserve debris (${debris})`]).out.trim();
			fx.git(["update-ref", `refs/blam/debris/${debris.replace(/\//g, "-")}`, sha]);
		}
		clearMergeState(fx);
		removeMergeMarker(fx);
		this.#event("heal", debris);
	}

	#runMerges(fx: Fixture): void {
		for (const b of [...this.#pendingMerges]) {
			if (this.#failed.has(b)) continue;
			const r = fx.git(["merge", "--no-ff", "-m", `merge ${b}`, b]);
			if (r.ok) this.#event("merge-ok", b);
			else {
				this.#failed.add(b);
				this.#event("branch-failed", b);
			}
			this.#pendingMerges.splice(this.#pendingMerges.indexOf(b), 1);
		}
	}

	#retireCycle(fx: Fixture): void {
		const lanes = laneMarkers(fx);
		const candidates = lanes.filter((m) => !this.#registry.has(m.branch));
		if (this.midSweepHook !== null) {
			const hook = this.midSweepHook;
			this.midSweepHook = null;
			hook();
		}
		for (const m of candidates) {
			if (this.era === "pre") {
				this.#retire(fx, m.branch);
				continue;
			}
			// post: act-time ground-truth revalidation (C1/C3 guards)
			const row = fx.procs.get(m.pid);
			if (row?.alive) {
				this.#event("skip-alive", m.branch);
				continue;
			}
			if (!branchExists(fx, m.branch)) {
				this.#event("skip-vanished", m.branch);
				continue;
			}
			this.#retire(fx, m.branch);
		}
	}

	#retire(fx: Fixture, branch: string): void {
		const r = fx.git(["branch", "-D", branch]);
		if (!r.ok) {
			this.#event("retire-vanished", branch);
			return;
		}
		this.#event("retire", branch);
	}

	onScenarioEnd(): PlaneReport {
		return { era: this.era, events: this.events };
	}
}

function laneMarkers(fx: Fixture): LaneMarker[] {
	const dir = join(fx.fleet, "lanes");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) =>
		JSON.parse(readFileSync(join(dir, f), "utf8")) as LaneMarker
	);
}

function inMergeState(fx: Fixture): boolean {
	return fx.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok || stagedFiles(fx).length > 0;
}

/** Branch the MERGE_HEAD came from (name-rev; sha fallback). */
function mergeDebrisBranch(fx: Fixture): string {
	const r = fx.git(["name-rev", "--name-only", "--refs=refs/heads/*", "MERGE_HEAD"]);
	return r.ok && r.out.length > 0 ? r.out : "unknown";
}

/** Merge-debris seed shared by S2/S4/S5: a real mid-merge state (MERGE_HEAD
 * + staged results) from a branch the scenario names, plus the merge-active
 * marker and its runner stand-in row (dead unless the scenario seeds it
 * live/recycled). */
export function seedCrashedMerge(
	plane: ScriptedControlPlane,
	fx: Fixture,
	debrisBranch: string,
	marker: { pid: number; cmd: string; ts: number },
): void {
	fx.git(["branch", debrisBranch, fx.base]);
	fx.git(["checkout", "-q", debrisBranch]);
	writeFileSync(join(fx.repo, "debris.txt"), `debris from ${debrisBranch}\n`);
	fx.git(["add", "debris.txt"]);
	fx.git(["commit", "-q", "-m", `work on ${debrisBranch}`]);
	fx.git(["checkout", "-q", "main"]);
	fx.git(["merge", "--no-commit", "--no-ff", debrisBranch]);
	if (!fx.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) {
		throw new Error(`debris seed failed: no MERGE_HEAD (${fx.repo})`);
	}
	writeMergeMarker(fx, marker);
	if (fx.procs.has(marker.pid)) return;
	fx.procs.set(marker.pid, { pid: marker.pid, cmd: marker.cmd, alive: false });
}
