import { z } from "zod";
import { path, section } from "./settings.leaf.ts";

export const RunnerServiceUrlSchema = z
	.url()
	.max(4096)
	.refine((value) => {
		const url = new URL(value);
		return (
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			url.pathname === "/" &&
			(url.protocol === "https:" ||
				(url.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
		);
	}, "HTTPS service URL required except on loopback; no credentials, path or query");

export const RunnerSettingsSchema = section(
	{
		control_url: RunnerServiceUrlSchema.default(
			"http://127.0.0.1:7810",
		).describe("Durable runner control service"),
		identity_url: RunnerServiceUrlSchema.default(
			"http://127.0.0.1:4111",
		).describe("Buckle identity authority for runner credentials"),
		credential_file: path(
			"~/.config/klh/runner.key",
			"Private runner user credential; never an implicit root key",
		),
		profiles_file: path(
			"~/.config/klh/runner-profiles.json",
			"Host-approved immutable runner profiles",
		),
		state_dir: path(
			"~/.local/state/klh/runners",
			"Private host runner state and credential bindings",
		),
	},
	"Durable runner service and client configuration",
);
