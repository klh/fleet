// settings.hubs.ts — `hubs`: a map keyed by hub LABEL, the exact name a
// repo's `.prefer` pins (`hub=<label>`, W228). One HubSchema per label
// replaces the three scattered sources: stack.json hub profiles, the
// ~/.claude/local-llm/hubs.json candidate registry, and SUSPENDERS_HUBS_FILE.
// Secrets NEVER inline: a token is a path to a 0600 file (token_file,
// secrets.*). Ports/binds group under `ports`/`health_ports`/`binds`;
// toHubProfile() (settings.project.ts) flattens back to the legacy profile
// shape hubctl and resolveHub consume during the transition.
import { z } from "zod";
import { opt, port } from "./settings.leaf.ts";

const strs = (desc: string) =>
	z.array(z.string().min(1).max(4096)).max(256).optional().describe(desc);

const Ports = z
	.object({
		buckle: port("Buckle gateway port"),
		board: port("Fleet board port"),
		store: port("Store-server port"),
		belt: port("Belt router port"),
		model_store: port("Hub model store port"),
		buckle_ready: port("buckle-ready synthetic readiness port"),
	})
	.strict()
	.describe("Service ports this hub serves");

const HealthPorts = z
	.object({
		buckle: port("buckle-health sidecar port"),
		board: port("board-health sidecar port"),
		store: port("store-health sidecar port"),
		belt: port("belt-health sidecar port"),
		model_store: port("model-store health sidecar port"),
	})
	.strict()
	.describe("Outside-process health sidecar ports");

const Binds = z
	.object({
		buckle: opt("Buckle bind address"),
		board: opt("Board bind address"),
		belt: opt("Belt bind address"),
	})
	.strict()
	.describe("Bind addresses");

const Deploy = z
	.object({
		ssh: opt("ssh target (user@host)"),
		dir: z.string().min(1).describe("Deploy dir on the hub device"),
		docker: opt("docker binary path on the hub"),
		compose: opt("compose invocation override"),
		connect_timeout: z.number().int().min(1).max(600).optional(),
	})
	.strict()
	.describe("Deploy target (git-pulled volumes, never host paths)");

const Repos = z
	.object({
		ref: opt("Git ref pin"),
		buckle: opt("buckle origin override"),
		suspenders: opt("suspenders origin override"),
		belt: opt("belt origin override"),
		src: opt("Packages root inside the clone"),
	})
	.strict();

const Secrets = z
	.object({
		buckle_root_key: opt("PATH of the 0600 buckle root key on the hub"),
		buckle_service_key: opt("PATH of the 0600 buckle service key"),
		buckle_service_key_env: opt("Env NAME carrying the service key"),
		upstream_keys: z
			.record(z.string(), z.string())
			.optional()
			.describe("Upstream key env NAME → 0600 file PATH"),
	})
	.strict()
	.describe("Secret PATHS on the owning device — values never live here");

/** Opaque, owner-validated blocks (their schemas live with their owning
 *  package: posture, buckle gateway policy, upstream ladders). */
const opaque = (desc: string) =>
	z.record(z.string(), z.unknown()).optional().describe(desc);

export const HubSchema = z
	.object({
		host: opt("Hub host (ssh user@ stripped for routing)"),
		display_name: opt("Human-facing label"),
		console_url: opt("Browser-facing console URL"),
		role: z
			.enum(["local", "remote", "peer"])
			.optional()
			.describe("This machine's relation to the hub"),
		candidates: strs("Candidate front URLs resolveHub walks (hubs.json)"),
		url: opt("The buckle front URL this hub serves"),
		token_file: opt("PATH of a 0600 file holding the hub front token"),
		version_override: opt("Reviewed canary ref for this hub only"),
		ports: Ports.optional(),
		health_ports: HealthPorts.optional(),
		binds: Binds.optional(),
		allowed_hosts: strs("Host header allowlist"),
		peers: strs("Peer hub labels"),
		services_json: opt("Services manifest override"),
		quiet_hours: z
			.string()
			.regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/)
			.optional()
			.describe("Nightly dark window HH:MM-HH:MM (routing skips)"),
		knowledge: z
			.object({
				port: port("Knowledge sink port"),
				health_port: port("Sink health"),
			})
			.strict()
			.optional(),
		ready_model: opt("Model the readiness leg asks"),
		buckle_entry: opt("Buckle entrypoint override"),
		http_upstream_hosts: strs("Private hosts reachable over plain http"),
		provider_intents: strs("Display-only provider placements"),
		provider_requirements: strs("Central provider profiles this hub requires"),
		deploy: Deploy.optional(),
		repos: Repos.optional(),
		secrets: Secrets.optional(),
		belt_model: opaque("Belt-owned OpenAI model wire"),
		route_preflight: opaque("Route preflight terminal origins"),
		mdns: opaque("mDNS announcer knobs"),
		overlay: opaque("Overlay code-loader knobs"),
		trace_tunnel: opaque("Trace tunnel front"),
		upstreams: opaque("The hub's real upstream ladder"),
		buckle_prefs: opaque("Routing-decision gates"),
		metrics: opaque("Native metrics connector"),
		buckle_gateway: opaque("Per-hub buckle gateway policy overrides"),
		settings: opaque(
			"Deep-partial SettingsSchema overlay for this hub's own install (validated after merge)",
		),
	})
	.strict();

export type Hub = z.infer<typeof HubSchema>;

export const HubsSchema = z
	.record(
		z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
		HubSchema,
	)
	.default({})
	.describe("Hubs keyed by .prefer label");
