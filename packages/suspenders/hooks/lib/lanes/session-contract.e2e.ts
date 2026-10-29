// session-contract.e2e.ts — hub-of-one phase 6: the fleet-loop controller
// lease holder is the ONLY supervisor. A session descends from the live
// holder → supervisor; absent lease, or a live holder that is not an
// ancestor → worker; the SUSPENDERS_SESSION_CONTRACT=supervisor hatch
// restores the old shape. The worker contract keeps manual dispatch.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import {
	acquireControllerLease,
	currentControllerIdentity,
} from "../../../scripts/lib/controller-fence.ts";
import { isControllerSession, workerContract } from "./session-contract.ts";

test.describe("@unit session contract", () => {
	test.describe.configure({ mode: "serial" });
	const world = scratchWorld({ prefix: "session-contract-" });
	const db = new Database(join(world.home, "fence.db"));
	const store = db;
	test.afterAll(() => {
		db.close();
		world.clean();
	});

	test("no controller lease → every session is a worker", () => {
		expect(isControllerSession(store, "p-none", process.pid)).toBe(false);
	});

	test("a descendant of the live lease holder is the supervisor", () => {
		expect(
			acquireControllerLease(
				store,
				"p-held",
				currentControllerIdentity("contract-fixture", import.meta.path),
			),
		).toBe(true);
		const child = Bun.spawn(["sleep", "5"]);
		try {
			expect(isControllerSession(store, "p-held", child.pid)).toBe(true);
			expect(isControllerSession(store, "p-held", process.pid)).toBe(true);
		} finally {
			child.kill();
		}
	});

	test("a live holder that is not an ancestor leaves the session a worker", () => {
		// our parent is not a descendant of this process (the lease holder)
		expect(isControllerSession(store, "p-held", process.ppid)).toBe(false);
	});

	test("the escape hatch restores the supervisor shape", () => {
		process.env.SUSPENDERS_SESSION_CONTRACT = "supervisor";
		try {
			expect(isControllerSession(store, "p-none", process.ppid)).toBe(true);
		} finally {
			delete process.env.SUSPENDERS_SESSION_CONTRACT;
		}
	});

	test("the worker contract keeps manual dispatch and forbids refill loops", () => {
		const text = workerContract(3, "CONTROL SNAPSHOT: controller=absent.");
		expect(text.startsWith("WORKER CONTRACT:")).toBe(true);
		expect(text).toContain("only supervisor");
		expect(text).toContain("Manual dispatch stays allowed");
		expect(text).toContain("Never arm a refill cron");
		expect(text).toContain("(3 now)");
	});
});
