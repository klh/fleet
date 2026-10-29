// hub-remote.ts — the remote-exec primitives hubctl and belt's hub heal
// (W371) share. Pure argv builders only — no exec here, callers spawn.
// Command strings ride ssh as ONE argv element (BatchMode + ConnectTimeout);
// local compose runs through /bin/sh -c exactly as hubctl's runOnHub does.

import type { HubProfile } from "../hooks/lib/stack-config.ts";

export const DEFAULT_CONNECT_TIMEOUT = 10;

/** ssh/scp -o flags — an unreachable hub fails in seconds (not ~75s of TCP
 *  retries) and never blocks on a password prompt. Timeout is the stack.json
 *  `deploy.connect_timeout` knob (seconds). */
export function sshOpts(hub: HubProfile): string[] {
	const t = hub.deploy?.connect_timeout;
	const secs =
		typeof t === "number" && Number.isFinite(t) && t > 0
			? Math.ceil(t)
			: DEFAULT_CONNECT_TIMEOUT;
	return ["-o", `ConnectTimeout=${secs}`, "-o", "BatchMode=yes"];
}

/** docker compose up -d as an argument array — ssh-wrapped when the profile
 *  declares deploy.ssh (the remote command string is one argv element, the
 *  hub's shell parses it there), /bin/sh -c when the hub is local docker.
 *  Throws when the hub declares no deploy.dir — nothing to compose up. */
export function composeUpArgv(hub: HubProfile): string[] {
	const dir = hub.deploy?.dir;
	if (!dir)
		throw new Error(
			"hub has no deploy.dir in stack.json — declare where hub-compose.yaml + .env live on the hub",
		);
	const docker = hub.deploy?.docker ?? "docker";
	const script = `${docker} compose -f ${JSON.stringify(`${dir}/hub-compose.yaml`)} --project-directory ${JSON.stringify(dir)} up -d`;
	if (hub.deploy?.ssh) return ["ssh", ...sshOpts(hub), hub.deploy.ssh, script];
	return ["/bin/sh", "-c", script];
}
