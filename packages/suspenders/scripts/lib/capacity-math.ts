// scripts/lib/capacity-math.ts — W842 pure helpers for the capacity bench
// (no side effects; tests import this directly, the bench script owns I/O).
export const p95 = (walls: number[]): number | null => {
	if (walls.length === 0) return null;
	const s = [...walls].sort((a, b) => a - b);
	return s[Math.ceil(0.95 * s.length) - 1];
};

/** task argv split; a leading "bun" token is implied (spawn adds it) */
export const splitTask = (task: string): string[] => {
	const parts = task.split(" ").filter(Boolean);
	return parts[0] === "bun" ? parts.slice(1) : parts;
};

/** parse macOS `top -l 1 -n 0`: active CPU % (user+sys) and used-mem GB */
export const parseTop = (
	out: string,
): { cpuActive: number | null; memUsedGb: number | null } => {
	const cpu = out.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys/);
	if (!cpu) return { cpuActive: null, memUsedGb: null };
	const mem = out.match(/PhysMem:\s*([\d.]+)G used/);
	return {
		cpuActive: Math.round((Number(cpu[1]) + Number(cpu[2])) * 10) / 10,
		memUsedGb: mem ? Number(mem[1]) : null,
	};
};

/** parse `df -k <path>` → available KiB on the volume holding <path> */
export const parseDf = (out: string): number | null => {
	const lines = out.trim().split("\n");
	const row = lines[lines.length - 1]?.split(/\s+/);
	const avail = row ? Number(row[3]) : NaN;
	return Number.isFinite(avail) ? avail : null;
};
