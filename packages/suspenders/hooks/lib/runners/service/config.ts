import { expandHome, type RunnerSettingsSchema } from "@klh/settings";
import { createRunnerIdentity } from "../api/identity.ts";

/** The host binds to IPv4 loopback. A remote control URL belongs to clients. */
export function runnerHostConfig(
	config: ReturnType<typeof RunnerSettingsSchema.parse>,
) {
	const control = new URL(config.control_url);
	if (
		control.protocol !== "http:" ||
		control.hostname !== "127.0.0.1" ||
		!control.port ||
		control.port === "0"
	)
		throw new Error("runner.local_listener_requires_loopback_port");
	return {
		stateDir: expandHome(config.state_dir),
		profilesFile: expandHome(config.profiles_file),
		port: Number(control.port),
		identity: createRunnerIdentity({ baseUrl: config.identity_url }),
	};
}
