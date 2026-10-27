import { expect, test } from "./pw";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireApprovalFence,
	approvalFencePath,
	assertFenceForLifecycle,
	markApprovalPublished,
	releaseApprovalFence,
	type ApprovalFence,
} from "../scripts/lib/approval-fence.ts";

const LABEL = "com.suspenders.buckle-spoke";
const TOKEN = "a".repeat(64);
const live = () => ({ birth: "birth-a", command: "writer" });

test("obsolete wall-clock birth is unknown and cannot stale-break a live approval fence", () => {
	const f = staging();
	try {
		seedFence(f.staging, {
			birth: "{ sec = 1, usec = 2 }:100:200",
			acquiredAt: 0,
			expiresAt: 1,
		});
		const inspect = () => ({
			birth: "darwin:12345678-1234-1234-1234-123456789abc:100:200",
			command: "writer",
		});
		expect(() =>
			acquireApprovalFence(f.staging, LABEL, TOKEN, { inspect }),
		).toThrow("identity unknown");
		expect(() =>
			assertFenceForLifecycle(f.staging, LABEL, { inspect }),
		).toThrow("identity unknown");
		expect(
			JSON.parse(readFileSync(approvalFencePath(f.staging, LABEL), "utf8"))
				.birth,
		).toBe("{ sec = 1, usec = 2 }:100:200");
	} finally {
		f.clean();
	}
});

/** Seed a valid foreign-owner record; pid 999999 is never this writer. */
function seedFence(staging: string, overrides: Partial<ApprovalFence>): void {
	writeFileSync(
		approvalFencePath(staging, LABEL),
		JSON.stringify({
			schema: "fleet.approval-fence.v1",
			label: LABEL,
			token: TOKEN,
			pid: 999_999,
			birth: "birth-h",
			state: "PREPARING",
			acquiredAt: Date.now() - 1_000,
			expiresAt: Date.now() + 119_000,
			...overrides,
		}),
		{ mode: 0o600 },
	);
}

function staging() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "approval-fence-")));
	const staging = join(root, "gateway-review");
	mkdirSync(staging, { recursive: true });
	return {
		staging,
		clean: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("acquire creates the fence record with owner identity and 0600 mode", () => {
	const f = staging();
	try {
		const fence = acquireApprovalFence(f.staging, LABEL, TOKEN, {
			inspect: live,
		});
		expect(fence.schema).toBe("fleet.approval-fence.v1");
		expect(fence.label).toBe(LABEL);
		expect(fence.token).toBe(TOKEN);
		expect(fence.state).toBe("PREPARING");
		expect(fence.birth).toBe("birth-a");
	} finally {
		f.clean();
	}
});

test("competing supported upgrade refuses while a live unexpired owner holds the fence", () => {
	const f = staging();
	try {
		acquireApprovalFence(f.staging, LABEL, TOKEN, { inspect: live });
		expect(() =>
			acquireApprovalFence(f.staging, LABEL, "b".repeat(64), {
				inspect: live,
			}),
		).toThrow("another approved writer holds the gateway approval fence");
		expect(existsSync(approvalFencePath(f.staging, LABEL))).toBe(true);
	} finally {
		f.clean();
	}
});

test("proven-dead owner is stale-broken and the record stays auditable", () => {
	const f = staging();
	try {
		seedFence(f.staging, {});
		const dead = (pid: number) => (pid === process.pid ? live() : false);
		const next = acquireApprovalFence(f.staging, LABEL, "b".repeat(64), {
			inspect: dead,
		});
		expect(next.token).toBe("b".repeat(64));
		const leftovers = readdirSync(f.staging).filter((name) =>
			name.includes(".stale-"),
		);
		expect(leftovers.length).toBe(1);
	} finally {
		f.clean();
	}
});

test("recycled PID (birth mismatch) is a stale-break, not a takeover", () => {
	const f = staging();
	try {
		acquireApprovalFence(f.staging, LABEL, TOKEN, { inspect: live });
		const recycled = () => ({ birth: "birth-b", command: "recycled" });
		const next = acquireApprovalFence(f.staging, LABEL, "c".repeat(64), {
			inspect: recycled,
		});
		expect(next.token).toBe("c".repeat(64));
	} finally {
		f.clean();
	}
});

test("expired lease stale-breaks even while the holder process is alive", () => {
	const f = staging();
	try {
		let clock = 1_000;
		acquireApprovalFence(f.staging, LABEL, TOKEN, {
			inspect: live,
			now: () => clock,
			leaseMs: 500,
		});
		clock = 1_600;
		const next = acquireApprovalFence(f.staging, LABEL, "d".repeat(64), {
			inspect: live,
			now: () => clock,
		});
		expect(next.token).toBe("d".repeat(64));
	} finally {
		f.clean();
	}
});

test("unknown owner identity refuses without touching the record", () => {
	const f = staging();
	try {
		seedFence(f.staging, {});
		const before = readFileSync(approvalFencePath(f.staging, LABEL), "utf8");
		expect(() =>
			acquireApprovalFence(f.staging, LABEL, "e".repeat(64), {
				inspect: (pid: number) => (pid === process.pid ? live() : null),
			}),
		).toThrow("owner identity unknown");
		expect(readFileSync(approvalFencePath(f.staging, LABEL), "utf8")).toBe(
			before,
		);
	} finally {
		f.clean();
	}
});

test("corrupt fence record refuses without touching the record", () => {
	const f = staging();
	try {
		writeFileSync(approvalFencePath(f.staging, LABEL), "{corrupt", {
			mode: 0o600,
		});
		const before = readFileSync(approvalFencePath(f.staging, LABEL), "utf8");
		expect(() =>
			acquireApprovalFence(f.staging, LABEL, "f".repeat(64), {
				inspect: live,
			}),
		).toThrow("approval fence record is invalid");
		expect(readFileSync(approvalFencePath(f.staging, LABEL), "utf8")).toBe(
			before,
		);
	} finally {
		f.clean();
	}
});

test("markApprovalPublished is predicated on owner and token", () => {
	const f = staging();
	try {
		const fence = acquireApprovalFence(f.staging, LABEL, TOKEN, {
			inspect: live,
		});
		markApprovalPublished(f.staging, LABEL, fence, TOKEN);
		expect(
			JSON.parse(readFileSync(approvalFencePath(f.staging, LABEL), "utf8"))
				.state,
		).toBe("PUBLISHED");
		expect(() =>
			markApprovalPublished(f.staging, LABEL, fence, "b".repeat(64)),
		).toThrow("replaced mid-publish");
	} finally {
		f.clean();
	}
});

test("release is predicated: matching owner unlinks, replaced record stays", () => {
	const f = staging();
	try {
		const fence = acquireApprovalFence(f.staging, LABEL, TOKEN, {
			inspect: live,
		});
		releaseApprovalFence(f.staging, LABEL, fence, TOKEN);
		expect(existsSync(approvalFencePath(f.staging, LABEL))).toBe(false);
		acquireApprovalFence(f.staging, LABEL, "b".repeat(64), {
			inspect: live,
		});
		releaseApprovalFence(f.staging, LABEL, fence, TOKEN);
		expect(existsSync(approvalFencePath(f.staging, LABEL))).toBe(true);
	} finally {
		f.clean();
	}
});

test("lifecycle boundary: live unexpired fence passes, expired refuses", () => {
	const f = staging();
	try {
		expect(() =>
			assertFenceForLifecycle(f.staging, LABEL, { inspect: live }),
		).toThrow("requires the approval fence");
		let clock = 1_000;
		const fence = acquireApprovalFence(f.staging, LABEL, TOKEN, {
			inspect: live,
			now: () => clock,
			leaseMs: 500,
		});
		const seen = assertFenceForLifecycle(f.staging, LABEL, {
			inspect: live,
			now: () => clock,
		});
		expect(seen.token).toBe(fence.token);
		clock = 1_600;
		expect(() =>
			assertFenceForLifecycle(f.staging, LABEL, {
				inspect: live,
				now: () => clock,
			}),
		).toThrow("fence expired; bootout refused");
	} finally {
		f.clean();
	}
});

test("lifecycle boundary: dead fence owner cannot bootout", () => {
	const f = staging();
	try {
		seedFence(f.staging, {});
		expect(() =>
			assertFenceForLifecycle(f.staging, LABEL, {
				inspect: (pid: number) => (pid === process.pid ? live() : false),
			}),
		).toThrow("fence owner is dead; bootout refused");
	} finally {
		f.clean();
	}
});
