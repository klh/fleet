import { join } from "node:path";
import { freePort, waitUp } from "@klh/test-kit";
import type { fixture } from "./fixture.ts";
type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function docker(args: string[]) {
	const child = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { out, err, code };
}
export function safe(text: string, data: Fixture) {
	return text
		.replaceAll(data.rootKey, "[redacted]")
		.replaceAll(data.upstreamKey, "[redacted]");
}
export function containerArgs(
	data: Fixture,
	platform: string,
	mode: "runtime" | "neutral" | "unauthenticated",
) {
	return [
		"--platform",
		platform,
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--tmpfs",
		"/data:rw,uid=1000,gid=1000",
		"--tmpfs",
		"/tmp:rw,uid=1000,gid=1000",
		"--env-file",
		join(data.world.home, `${mode}.env`),
		"--mount",
		`type=bind,source=${data.site},target=/site,readonly`,
	];
}
export async function start(
	data: Fixture,
	image: string,
	platform: string,
	mode: "runtime" | "neutral" | "unauthenticated",
) {
	const port = await freePort();
	const boot = await docker([
		"run",
		"--detach",
		...containerArgs(data, platform, mode),
		"--publish",
		`127.0.0.1:${port}:4101`,
		image,
	]);
	if (boot.code !== 0) throw Error(safe(boot.err, data));
	const id = boot.out.trim(),
		origin = `http://127.0.0.1:${port}`;
	try {
		await waitUp(`${origin}/status`, { tries: 100 });
	} catch (error) {
		const logs = await docker(["logs", id]);
		await docker(["rm", "-f", id]);
		throw Error(`${String(error)}: ${safe(logs.out + logs.err, data)}`);
	}
	return { id, origin };
}
