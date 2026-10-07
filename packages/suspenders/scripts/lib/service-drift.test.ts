import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
	digestUnit,
	driftNotices,
	inspectServices,
	type ActivationReceipt,
	type Inspect,
	readActivation,
	retainActivation,
	writeActivation,
} from "./service-drift.ts";
const unit = "activated definition",
	manifest = "manifest definition";
const receipt: ActivationReceipt = {
	schema: "fleet.service-activation.v1",
	platform: "darwin",
	domain: "gui/501",
	manifest: "/manifest",
	manifestSha256: digestUnit(manifest),
	services: [
		{
			label: "com.suspenders.board",
			unit: "/unit",
			unitSha256: digestUnit(unit),
			arguments: ["/bun", "/board.ts"],
			resident: true,
			port: 7799,
		},
	],
};
const loaded = (
	pid: number | null = 12,
	args = ["/bun", "/board.ts"],
	state = "running",
) =>
	`gui/501/com.suspenders.board = {\n state = ${state}\n arguments = {\n ${args.join("\n ")}\n }\n${pid ? ` pid = ${pid}\n` : ""}}`;
function probe(
	options: {
		pid?: number | null;
		listeners?: string;
		error?: string;
		code?: number;
		disabled?: boolean;
		args?: string[];
		state?: string;
		inspectError?: boolean;
	} = {},
): Inspect {
	return (args) => {
		if (options.inspectError)
			return { code: 1, out: "", error: "inspection unavailable" };
		if (args[1] === "print-disabled")
			return {
				code: 0,
				out: `"com.suspenders.board" => ${options.disabled ? "true" : "false"}`,
				error: "",
			};
		if (args[0].includes("lsof"))
			return {
				code: 0,
				out: options.listeners ?? String(options.pid ?? 12),
				error: "",
			};
		return {
			code: options.code ?? 0,
			out: loaded(
				options.pid === undefined ? 12 : options.pid,
				options.args,
				options.state,
			),
			error: options.error ?? "",
		};
	};
}
const inspect = (options: Parameters<typeof probe>[0] = {}, custom = receipt) =>
	inspectServices(custom, "gui/501", "/manifest", probe(options), (path) =>
		path === "/manifest" ? manifest : unit,
	)[0];
test("activation list is authoritative; optional manifest services are not inferred", () => {
	expect(
		inspectServices(
			{ ...receipt, services: [] },
			"gui/501",
			"/manifest",
			probe(),
			() => unit,
		),
	).toEqual([]);
});
test("matching supervised resident owns its listener", () => {
	expect(inspect().state).toBe("running");
});
test("loaded scheduled jobs without PID are healthy idle", () => {
	expect(
		inspect(
			{ pid: null, state: "not running" },
			{ ...receipt, services: [{ ...receipt.services[0], resident: false }] },
		).state,
	).toBe("scheduled-idle");
});
test("missing service in exact domain is unloaded; general inspection failure remains unknown", () => {
	expect(inspect({ code: 113, error: "Could not find service" }).state).toBe(
		"unloaded",
	);
	expect(inspect({ code: 1, error: "permission denied" }).state).toBe(
		"unknown",
	);
	expect(inspect({ inspectError: true }).state).toBe("unknown");
});
test("a receipt for another domain cannot prove current service activation", () => {
	expect(inspect({}, { ...receipt, domain: "gui/502" }).state).toBe("unknown");
});
test("disabled override is distinct from unloaded", () => {
	expect(inspect({ disabled: true }).state).toBe("disabled");
});
test("stale loaded arguments plus a manual healthy listener are not supervision", () => {
	expect(
		inspect({ args: ["/bun", "/old-board.ts"], listeners: "99" }).state,
	).toBe("drift");
	expect(inspect({ listeners: "99" }).state).toBe("degraded");
});
test("unit and canonical manifest drift invalidate the activation proof", () => {
	expect(
		inspectServices(receipt, "gui/501", "/manifest", probe(), (path) =>
			path === "/manifest" ? manifest : "changed",
		)[0].state,
	).toBe("drift");
	expect(
		inspectServices(
			receipt,
			"gui/501",
			"/manifest",
			probe(),
			() => "changed",
		)[0].state,
	).toBe("drift");
});
test("missing unit inspection remains unknown", () => {
	expect(
		inspectServices(receipt, "gui/501", "/manifest", probe(), () => {
			throw Error("unavailable");
		})[0].state,
	).toBe("unknown");
});
test("legitimate PID replacement causes no notification or recovery request", () => {
	const prior = driftNotices([inspect()], {}, 1000);
	const next = driftNotices(
		[inspect({ pid: 13 })],
		prior.fingerprints,
		2000,
		1000,
	);
	expect(next.notices).toEqual([]);
});
test("findings dedupe and recheck once per bounded reminder interval; recovery is broadcastable", () => {
	const first = driftNotices([inspect({ disabled: true })], {}, 1000);
	expect(first.notices).toHaveLength(1);
	expect(
		driftNotices([inspect({ disabled: true })], first.fingerprints, 2000, 1000)
			.notices,
	).toEqual([]);
	expect(
		driftNotices(
			[inspect({ disabled: true })],
			first.fingerprints,
			3601001,
			1000,
		).notices,
	).toHaveLength(1);
	expect(
		driftNotices([inspect()], first.fingerprints, 2000, 1000).notices,
	).toHaveLength(1);
});

test("atomic successful receipt is private and failed publication preserves previous intent", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-service-receipt-")),
		path = join(root, "activation.json");
	try {
		writeActivation(path, receipt);
		expect(readActivation(path)).toEqual(receipt);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const bytes = readFileSync(path, "utf8");
		expect(() =>
			writeActivation(path, { ...receipt, services: [] }, () => {
				throw Error("publication failed");
			}),
		).toThrow("publication failed");
		expect(readFileSync(path, "utf8")).toBe(bytes);
		expect(() =>
			writeActivation(path, { ...receipt, domain: "invalid" }),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(bytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bounded PID recheck accepts launchd replacement between listener observations", () => {
	let prints = 0;
	const base = probe({ listeners: "13" });
	const inspect: Inspect = (args) =>
		args[1] === "print"
			? { code: 0, out: loaded(++prints === 1 ? 12 : 13), error: "" }
			: base(args);
	const result = inspectServices(
		receipt,
		"gui/501",
		"/manifest",
		inspect,
		(path) => (path === "/manifest" ? manifest : unit),
	)[0];
	expect(result.state).toBe("running");
	expect(result.pid).toBe(13);
	expect(prints).toBe(2);
});

test("current configured declaration defeats a receipt anchored to an old generation", () => {
	const old = { ...receipt, manifest: "/old-generation/manifest" };
	const requested: string[] = [];
	const result = inspectServices(
		old,
		"gui/501",
		"/current/manifest",
		probe(),
		(path) => {
			requested.push(path);
			return path === "/current/manifest"
				? "new declaration"
				: path === "/old-generation/manifest"
					? manifest
					: unit;
		},
	)[0];
	expect(result.state).toBe("drift");
	expect(requested).toContain("/current/manifest");
	expect(requested).not.toContain("/old-generation/manifest");
});
test("outside-process inspection uses absolute system launchctl", () => {
	const base = probe();
	const commands: string[] = [];
	inspectServices(
		receipt,
		"gui/501",
		"/manifest",
		(args) => {
			commands.push(args[0]);
			return base(args);
		},
		(path) => (path === "/manifest" ? manifest : unit),
	);
	expect(commands.filter((command) => command.includes("launchctl"))).toEqual([
		"/bin/launchctl",
		"/bin/launchctl",
	]);
});

test("failed periodic invocation is degraded, and ambiguous prior outcome is unknown", () => {
	const periodic = {
		...receipt,
		services: [{ ...receipt.services[0], resident: false }],
	};
	const state = (suffix: string) =>
		inspectServices(
			periodic,
			"gui/501",
			"/manifest",
			(args) =>
				args[1] === "print"
					? {
							code: 0,
							out: loaded(null, undefined, "not running").replace(
								"\n}",
								`${suffix}\n}`,
							),
							error: "",
						}
					: probe()(args),
			(path) => (path === "/manifest" ? manifest : unit),
		)[0].state;
	expect(state("\n last exit code = 7")).toBe("degraded");
	expect(state("\n last exit code = 0")).toBe("scheduled-idle");
	expect(state("\n last exit code = unreadable")).toBe("unknown");
	expect(state("\n runs = 1")).toBe("unknown");
	expect(state("\n runs = 0")).toBe("scheduled-idle");
});

test("retention preserves explicit optional intent only in the same activation domain", () => {
	const empty = { ...receipt, services: [] };
	expect(retainActivation(empty, receipt).services).toEqual(receipt.services);
	expect(
		retainActivation({ ...empty, domain: "gui/502" }, receipt).services,
	).toEqual([]);
	const changed = {
		...receipt,
		services: [
			{ ...receipt.services[0], arguments: ["/bun", "/new-board.ts"] },
		],
	};
	expect(retainActivation(changed, receipt).services).toEqual(changed.services);
});
