/** Stop server listeners only; health-check clients must survive recovery. */
export function killListeners(port: number): void {
	const result = Bun.spawnSync([
		"/usr/sbin/lsof",
		"-t",
		`-iTCP:${port}`,
		"-sTCP:LISTEN",
	]);
	for (const value of result.stdout.toString().trim().split(/\s+/)) {
		const pid = Number(value);
		if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// A listener can exit between discovery and signaling.
		}
	}
}
