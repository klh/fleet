import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { readRunnerCredential } from "../../hooks/lib/runners/api/credential.ts";
import {
	defineVerb,
	parseVerb,
	renderVerbHelp,
} from "../../hooks/lib/verb-kit.ts";

const AbsolutePathSchema = z.string().refine(isAbsolute);
export const HostDeploymentSchema = z.strictObject({
	networkMode: z.literal("host"),
	hostname: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
	uid: z.number().int().positive(),
	gid: z.number().int().nonnegative(),
	socketGid: z.number().int().nonnegative(),
	settings: AbsolutePathSchema,
	profiles: AbsolutePathSchema,
	controlKey: AbsolutePathSchema,
	mintKey: AbsolutePathSchema,
	readerKey: AbsolutePathSchema,
	state: AbsolutePathSchema,
	seed: AbsolutePathSchema,
	socket: AbsolutePathSchema,
});
/** Run on the Linux Docker host. State/seed sources must be mounted at these
 * identical absolute targets: the daemon resolves its own host paths. */
export function validateDeployment(raw: unknown) {
	const config = HostDeploymentSchema.parse(raw);
	for (const path of [config.state, config.seed]) {
		const stat = lstatSync(path);
		if (
			!stat.isDirectory() ||
			realpathSync(path) !== path ||
			stat.uid !== config.uid ||
			stat.mode & 0o077
		)
			throw new Error("host.private_directory_required");
	}
	const files = [
		config.settings,
		config.profiles,
		config.controlKey,
		config.mintKey,
		config.readerKey,
	].map((path) => {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			realpathSync(path) !== path ||
			stat.uid !== config.uid ||
			stat.mode & 0o077 ||
			stat.nlink !== 1 ||
			stat.size > 65536
		)
			throw new Error("host.private_file_required");
		return stat;
	});
	if (
		new Set(files.slice(2).map((stat) => `${stat.dev}:${stat.ino}`)).size !== 3
	)
		throw new Error("host.separate_credentials_required");
	if (
		new Set(
			[config.controlKey, config.mintKey, config.readerKey].map(
				readRunnerCredential,
			),
		).size !== 3
	)
		throw new Error("host.separate_credentials_required");
	const socket = lstatSync(config.socket);
	if (
		!socket.isSocket() ||
		socket.gid !== config.socketGid ||
		(socket.mode & 0o060) !== 0o060
	)
		throw new Error("host.socket_group_access_required");
	const SettingsBindingSchema = z.object({
		runner: z.object({
			credential_file: z.literal(config.controlKey),
			profiles_file: z.literal(config.profiles),
			state_dir: z.literal(config.state),
			desktop: z.object({
				seed_root: z.literal(config.seed),
				mint_credential_file: z.literal(config.mintKey),
			}),
		}),
	});
	SettingsBindingSchema.parse(privateJson(config.settings));
	return config;
}

function privateJson(path: string): unknown {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.uid !== process.getuid?.() ||
			stat.nlink !== 1 ||
			stat.mode & 0o077 ||
			stat.size > 65536
		)
			throw new Error("host.private_config_required");
		const bytes = Buffer.alloc(65537),
			size = readSync(fd, bytes, 0, bytes.length, 0);
		if (size !== stat.size || size > 65536)
			throw new Error("host.config_size_changed");
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
		);
	} finally {
		closeSync(fd);
	}
}
const verb = defineVerb({
	name: "validate",
	usage: "deployment.ts --file /private/deployment.json",
	flags: ["--file"],
	reqFlags: ["--file"],
});
if (import.meta.main) {
	const parsed = parseVerb(verb, process.argv.slice(2));
	if (!parsed.ok) {
		console.error(renderVerbHelp(verb));
		process.exit(2);
	}
	try {
		const path = parsed.parsed.flag("--file");
		if (!path) throw new Error("host.config_required");
		validateDeployment(privateJson(path));
		console.log(JSON.stringify({ deployment: "validated" }));
	} catch {
		console.error("host.deployment_invalid");
		process.exit(1);
	}
}
