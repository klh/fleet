/** Model endpoints advertise their loaded models on this read-only route.
 * Kev's OpenAPI declares /v1/models; / is explicitly not its health API. */
export function probePathFor(entry: { probePath?: string }): string {
	return entry.probePath ?? "/v1/models";
}

/** Process metadata is optional; launchd's sparse PATH must never break status. */
export function modelFromProcess(
	port: number,
	run: (command: string[]) => string = (command) =>
		Bun.spawnSync(command).stdout.toString(),
): string | null {
	try {
		const pid = run(["/usr/sbin/lsof", "-ti", `:${port}`])
			.trim()
			.split("\n")[0];
		if (!/^\d+$/.test(pid ?? "")) return null;
		const command = run(["/bin/ps", "-o", "command", "-p", pid]);
		return command.match(/--model\s+(\S+)/)?.[1] ?? null;
	} catch {
		return null;
	}
}
