// tests/review-eval/receipt.ts — W1172 receipt schema + hashing.
// Reproducibility pins: every receipt records the exact corpus sha, arm
// revisions + skill-content hashes, route/model pins and per-run records.
// Receipts land machine-local (0600) and are never committed; the protocol
// doc records the run procedure, never the payload bytes.

export function sha256(s: string): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(s);
	return h.digest("hex");
}

export type ArmReceipt = {
	rev: string;
	commit: string;
	skillPath: string;
	skillSha256: string;
};

export type JudgeScore = {
	perIssue: {
		id: string;
		found: boolean;
		cited?: string;
	}[];
	falsePositives: number;
	notes?: string;
};

export type Usage = {
	input: number;
	output: number;
	cacheRead: number;
};

export type RunRecord = {
	task: string;
	arm: "before" | "after";
	exitCode: number | null;
	durationMs: number;
	output: string;
	usage: Usage;
	costUsd: number | null;
	score: JudgeScore | null;
};

export type ArmTotals = {
	found: number;
	planted: number;
	falsePositives: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	costUsd: number | null;
};

export type Manifest = {
	runId: string;
	ts: string;
	gate: "W1172_GATE=open";
	corpusSha: string;
	taskIds: string[];
	arms: {
		before: ArmReceipt;
		after: ArmReceipt;
	};
	pins: {
		executor: "claude -p --output-format json";
		settingsPath: string;
		judge: { url: string; model: string };
	};
	runs: RunRecord[];
	totals: Record<"before" | "after", ArmTotals>;
};

export function emptyTotals(): Record<"before" | "after", ArmTotals> {
	const fresh = (): ArmTotals => ({
		found: 0,
		planted: 0,
		falsePositives: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		costUsd: null,
	});
	return { before: fresh(), after: fresh() };
}
