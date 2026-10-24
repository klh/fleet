import {
	laneProcessIdentity,
	isHarnessProcess,
} from "../../hooks/lib/lane-liveness.ts";
import {
	loadLaneRegistry,
	repairLaneRegistryPid,
} from "../../hooks/lib/lane-registry.ts";
import { processBirth } from "./launch-fencing.ts";
import type { Lane } from "../../hooks/lib/lane.ts";

type ProcessRow = { pid: number; ppid: number; args: string };
type Birth = { birth: string } | false | null;
type Witness = {
	child: number;
	parent: number;
	childBirth: string;
	parentBirth: string;
};
export type RepairProbe = {
	rows: () => ProcessRow[] | null;
	birth: (pid: number) => Birth;
};

const systemProbe: RepairProbe = {
	rows: () => {
		const p = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,args="], {
			stdout: "pipe",
			stderr: "pipe",
			maxBuffer: 8 * 1024 * 1024,
		});
		if (p.exitCode !== 0) return null;
		const rows: ProcessRow[] = [];
		for (const line of p.stdout.toString().split("\n")) {
			if (!line.trim()) continue;
			const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
			if (!m) return null;
			rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
		}
		return rows;
	},
	birth: processBirth,
};

/** A worktree cwd never proves identity. Require the current native child's
 * exact parent to be an SID-bearing managed wrapper, with both birth IDs. */
export function wrapperWitness(
	lane: Lane,
	probe: RepairProbe = systemProbe,
): Witness | null {
	const rows = probe.rows();
	if (!rows || !lane.pid) return null;
	const child = rows.find((r) => r.pid === lane.pid);
	const parent = child && rows.find((r) => r.pid === child.ppid);
	if (!child || !parent || !isHarnessProcess(child.args)) return null;
	// A prompt may mention a script path. Require the managed runtime in the
	// command position, not merely somewhere in the parent's argument text.
	const [executable, entrypoint] = parent.args.split(/\s+/, 3);
	if (
		!executable ||
		!entrypoint ||
		!/(?:^|\/)(?:bun|node)$/.test(executable) ||
		!entrypoint.endsWith("/claude-runtime.ts")
	)
		return null;
	const inspector = () => ({
		exitCode: 0,
		stdout: rows.map((r) => `${r.pid} ${r.args}`).join("\n"),
	});
	if (laneProcessIdentity({ ...lane, pid: parent.pid }, inspector) !== true)
		return null;
	const childBirth = probe.birth(child.pid);
	const parentBirth = probe.birth(parent.pid);
	if (!childBirth || !parentBirth) return null;
	return {
		child: child.pid,
		parent: parent.pid,
		childBirth: childBirth.birth,
		parentBirth: parentBirth.birth,
	};
}

export function repairManagedWrapperPid(
	fleet: string,
	sid: string,
	apply = false,
	probe: RepairProbe = systemProbe,
): {
	state: "would-repair" | "repaired" | "already-live" | "refused";
	pid?: number;
} {
	const row = loadLaneRegistry<Lane>(fleet).find((l) => l.sid === sid);
	if (!row) return { state: "refused" };
	const witness = wrapperWitness(row, probe);
	if (!witness) {
		if (laneProcessIdentity(row) === true)
			return { state: "already-live", pid: row.pid };
		return { state: "refused" };
	}
	if (!apply) return { state: "would-repair", pid: witness.parent };
	const repaired = repairLaneRegistryPid(fleet, row, witness.parent, () => {
		const fresh = wrapperWitness(row, probe);
		return fresh !== null && JSON.stringify(fresh) === JSON.stringify(witness);
	});
	return repaired
		? { state: "repaired", pid: witness.parent }
		: { state: "refused" };
}
