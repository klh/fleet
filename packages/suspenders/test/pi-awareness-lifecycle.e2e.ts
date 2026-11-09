import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

test("Pi factory starts no IO and binds actual two-argument lifecycle with cancellation @unit", async () => {
	const { default: awareness } = await import(
		"../pi-extensions/fleet-awareness/index.ts"
	);
	const world = scratchWorld({ prefix: "pi-lifecycle-" });
	const events = new Map<string, unknown>(),
		tools: string[] = [],
		commands: string[] = [];
	const signals: (AbortSignal | undefined)[] = [];
	const api: Pick<
		ExtensionAPI,
		"on" | "registerTool" | "registerCommand" | "exec"
	> = {
		on(name, handler) {
			events.set(name, handler);
		},
		registerTool(tool) {
			tools.push(tool.name);
		},
		registerCommand(name) {
			commands.push(name);
		},
		exec: async (_command, _args, options) => {
			signals.push(options?.signal);
			return {
				stdout: "[]",
				stderr: "",
				code: 0,
				killed: false,
				truncated: false,
			};
		},
	};
	const ctx = {
		cwd: world.home,
		hasUI: false,
		sessionManager: { getSessionId: () => "fixture" },
	} as unknown as ExtensionContext;
	try {
		awareness(api);
		expect(signals).toHaveLength(0);
		expect(tools).toContain("fleet");
		expect(commands).toEqual(["fleetpanel"]);
		for (const name of ["session_start", "session_shutdown"]) {
			const handler = events.get(name);
			expect(typeof handler).toBe("function");
			if (typeof handler === "function")
				handler({ type: name, reason: "startup" }, ctx);
		}
		expect(signals).toHaveLength(3);
		expect(signals.every((signal) => signal?.aborted)).toBe(true);
	} finally {
		world.clean();
	}
});
