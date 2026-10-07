import { processBirth, type ProcessBirth } from "./launch-fencing.ts";

export const parentPid = (pid: number): number | null => {
	const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "ppid="], {
		stdout: "pipe",
		stderr: "ignore",
		timeout: 3000,
	});
	const value = Number(result.stdout.toString().trim());
	return result.exitCode === 0 && Number.isSafeInteger(value) && value > 0
		? value
		: null;
};
export function identityMatches(
	first: ProcessBirth,
	current: ProcessBirth | false | null,
): boolean {
	return (
		!!current &&
		first.birth === current.birth &&
		first.command === current.command
	);
}
export function descendant(
	pid: number,
	owner: number,
	inspect: (pid: number) => number | null,
): boolean {
	const seen = new Set<number>();
	for (let depth = 0; depth < 8; depth++) {
		if (seen.has(pid)) return false;
		seen.add(pid);
		const next = inspect(pid);
		if (next === owner) return true;
		if (!next || next <= 1) return false;
		pid = next;
	}
	return false;
}
export interface OwnershipDeps {
	birth: typeof processBirth;
	parent: typeof parentPid;
}
/** Observe a bounded ancestry twice, fencing every PID against reuse and reparenting. */
export function stableDescendant(
	pid: number,
	owner: number,
	deps: OwnershipDeps = { birth: processBirth, parent: parentPid },
): "owned" | "unrelated" | "unknown" {
	if (
		!Number.isSafeInteger(pid) ||
		pid <= 1 ||
		!Number.isSafeInteger(owner) ||
		owner <= 1
	)
		return "unknown";
	const ownerBirth = deps.birth(owner);
	if (!ownerBirth) return ownerBirth === false ? "unrelated" : "unknown";
	const chain: { pid: number; parent: number; birth: ProcessBirth }[] = [];
	const seen = new Set<number>();
	for (let depth = 0; depth < 8; depth++) {
		if (seen.has(pid)) return "unrelated";
		seen.add(pid);
		const birth = deps.birth(pid);
		if (!birth) return birth === false ? "unrelated" : "unknown";
		const parent = deps.parent(pid);
		if (parent === null) return "unknown";
		chain.push({ pid, parent, birth });
		if (parent === owner) {
			if (!identityMatches(ownerBirth, deps.birth(owner))) return "unknown";
			for (const entry of chain)
				if (
					!identityMatches(entry.birth, deps.birth(entry.pid)) ||
					deps.parent(entry.pid) !== entry.parent
				)
					return "unknown";
			return "owned";
		}
		if (parent <= 1) return "unrelated";
		pid = parent;
	}
	return "unrelated";
}
