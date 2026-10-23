// tests/review-eval/corpus.ts — W1172 held-out review-eval corpus.
//
// Six held-out review targets with issues planted from the closed class
// vocabulary below (plus one deliberately clean control). Task payloads are
// bench artifacts — never import them into product code and never treat them
// as documentation. The planted-issue INVENTORY (which class at which line,
// which severity) is machine-local private judge material and is never
// committed; this file carries the tasks only. It does not run an agent and
// proves nothing about review quality by itself (W1144 regex-fixture law).
//
// t5 is the false-positive control: no issue is planted there.

export const ISSUE_CLASSES = {
	"pipe-to-tail":
		"a shell chain gates on the tail of a pipe, swallowing the real exit code",
	"sqlite-null-guard":
		"bun:sqlite .get() returns null on no match, so an !== undefined guard is always true",
	"empty-env-knob":
		"an empty-string env value passes a ?? fallback and counts as set",
	"unverified-claim":
		"a comment or message asserts a verified/green result with no baseline run behind it",
	"arg-null-zero":
		"Number() over an absent argument or null coerces to 0 and passes a guard",
	"correctness-generic":
		"a plain logic bug (off-by-one, wrong comparison, inverted condition)",
	"unbounded-buffer":
		"data accumulates without bound relative to an untrusted or unbounded input",
	"secret-in-source":
		"credential-looking material hardcoded in source",
} as const;

export type IssueClass = keyof typeof ISSUE_CLASSES;

export const ISSUE_CLASS_SET: ReadonlySet<string> = new Set(
	Object.keys(ISSUE_CLASSES),
);

export type ReviewTask = {
	id: string;
	name: string;
	ask: string;
	content: string;
};

const NEUTRAL_ASK =
	"Review the file below and report any issues you find. Do not modify anything; reply with the review only.";

export const TASKS: ReviewTask[] = [
	{
		id: "t1",
		name: "batch-close.ts",
		ask: NEUTRAL_ASK,
		content: `// batch-close.ts — closes finished orders in bulk for the nightly job
import { getDb } from "./db";

export async function closeFinishedOrders(orderIds: string[]): Promise<number> {
	const db = getDb();
	let closed = 0;
	for (let i = 0; i <= orderIds.length; i++) {
		const id = orderIds[i];
		const res = db.run(
			"UPDATE orders SET status = 'closed' WHERE id = ? AND status = 'done'",
			id,
		);
		closed += res.changes;
	}
	return closed;
}

// invoked from CI after the nightly batch; CI blocks on this check
export function verifyClosedCount(): boolean {
	const proc = Bun.spawnSync(["bash", "-c", "bun test test/orders.test.ts | tail -3"]);
	return proc.exitCode === 0;
}
`,
	},
	{
		id: "t2",
		name: "row-lookup.ts",
		ask: NEUTRAL_ASK,
		content: `// row-lookup.ts — resolves the primary account row for a customer
import { Database } from "bun:sqlite";

export function primaryAccount(db: Database, customerId: string) {
	const tenant = process.env.TENANT_ID ?? "tenant-default";
	const row = db
		.query(
			"SELECT * FROM accounts WHERE customer_id = ? AND tenant = ? AND is_primary = 1",
		)
		.get(customerId, tenant);
	if (row !== undefined) {
		return row;
	}
	return db
		.query("SELECT * FROM accounts WHERE customer_id = ? AND tenant = ? LIMIT 1")
		.get(customerId, tenant);
}
`,
	},
	{
		id: "t3",
		name: "quota-report.ts",
		ask: NEUTRAL_ASK,
		content: `// quota-report.ts — posts per-team quota usage to the vendor dashboard
const DASHBOARD_TOKEN = "dsh-live-redacted";

export function collectRows(events: Iterable<string>): string[] {
	const rows: string[] = [];
	for (const evt of events) {
		rows.push(evt.toUpperCase());
	}
	return rows;
}

export async function report(rows: string[]): Promise<void> {
	const body = JSON.stringify({ rows });
	await fetch("https://dashboard.vendor.example/api/quota", {
		method: "POST",
		headers: { authorization: "Bearer " + DASHBOARD_TOKEN },
		body,
	});
}
`,
	},
	{
		id: "t4",
		name: "verify-claim.ts",
		ask: NEUTRAL_ASK,
		content: `// verify-claim.ts — CI gate helper for release signing
function flag(name: string): string | null {
	const i = process.argv.indexOf(name);
	return i === -1 ? null : (process.argv[i + 1] ?? null);
}

export function timeoutSeconds(): number {
	return Number(flag("--timeout"));
}

export function releaseGate(): boolean {
	// verified: full suite green on this machine, zero failures
	return timeoutSeconds() > 0;
}
`,
	},
	{
		id: "t5",
		name: "clean-util.ts",
		ask: NEUTRAL_ASK,
		content: `// clean-util.ts — bounds a numeric value and renders a percentage label
export function clamp(value: number, lo: number, hi: number): number {
	if (Number.isNaN(value)) return lo;
	if (lo > hi) return lo;
	return Math.min(hi, Math.max(lo, value));
}

export function pctLabel(value: number, total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "0%";
	if (!Number.isFinite(value) || value < 0) return "0%";
	const pct = Math.round((value / total) * 100);
	return String(pct) + "%";
}
`,
	},
	{
		id: "t6",
		name: "drain.ts",
		ask: NEUTRAL_ASK,
		content: `// drain.ts — forwards audit events to the sink as fast as they arrive
const BATCH_LIMIT = Number(process.env.DRAIN_BATCH_LIMIT ?? "500");

export async function drain(events: AsyncIterable<string>): Promise<number> {
	const receipt: string[] = [];
	const batch: string[] = [];
	let forwarded = 0;
	for await (const evt of events) {
		receipt.push(evt);
		batch.push(evt);
		if (batch.length >= BATCH_LIMIT) {
			await sink(batch);
			batch.length = 0;
			forwarded += BATCH_LIMIT;
		}
	}
	if (batch.length > 0) {
		await sink(batch);
		forwarded += batch.length;
	}
	console.log("drained " + receipt.length + " events this run");
	return forwarded;
}

declare function sink(batch: string[]): Promise<void>;
`,
	},
];

export function taskById(id: string): ReviewTask | undefined {
	return TASKS.find((t) => t.id === id);
}

/** Deterministic content hash of the whole corpus (tasks + asks + bytes). */
export function corpusSha(): string {
	const h = new Bun.CryptoHasher("sha256");
	for (const t of TASKS) {
		h.update(t.id);
		h.update("\x1f");
		h.update(t.name);
		h.update("\x1f");
		h.update(t.ask);
		h.update("\x1f");
		h.update(t.content);
		h.update("\x1e");
	}
	return h.digest("hex");
}
