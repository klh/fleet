// vscode/src/api.ts — pure client for the fleet-board HTTP API
// (docs/board-api.md). No `vscode` import: bun tests this file without an
// editor runtime, and the bundle only wires it to VS Code in extension.ts.

export interface BoardTask {
	project: string;
	id: string;
	title: string;
	state: "READY" | "CLAIMED" | "RUNNING" | "BLOCKED" | "DONE" | "SHATTERED";
	owner_sid: string | null;
	owner_label: string | null;
	age_s: number;
	open_decisions: number;
	tail: { text: string; ts: string } | null;
	unblocked_by: string | null;
	executor: string | null;
	model: string | null;
	locality: string | null;
}

export interface BoardDecision {
	id: number;
	project: string | null;
	task_id: string | null;
	task_title: string | null;
	state: string;
	question: string;
	answer_note: string | null;
}

export interface BoardSnapshot {
	tasks: BoardTask[];
	decisions: BoardDecision[];
	/** true when the tasks feed answered but decisions failed — UI flags it. */
	decisionsDegraded: boolean;
}

export class BoardError extends Error {
	constructor(
		readonly status: number | null,
		message: string,
	) {
		super(message);
	}
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class BoardApi {
	constructor(
		readonly baseUrl: string,
		private readonly fetchImpl: FetchImpl = fetch,
	) {}

	async tasks(): Promise<BoardTask[]> {
		const body = await this.getJson<{ tasks?: BoardTask[] }>("/api/tasks");
		return body.tasks ?? [];
	}

	async decisions(): Promise<BoardDecision[]> {
		const body = await this.getJson<{ decisions?: BoardDecision[] }>(
			"/api/decisions",
		);
		return body.decisions ?? [];
	}

	/** Both feeds; a decisions failure degrades, a tasks failure throws. */
	async snapshot(): Promise<BoardSnapshot> {
		const [t, d] = await Promise.allSettled([this.tasks(), this.decisions()]);
		if (t.status === "rejected") throw t.reason;
		return {
			tasks: t.value,
			decisions: d.status === "fulfilled" ? d.value : [],
			decisionsDegraded: d.status === "rejected",
		};
	}

	private async getJson<T>(path: string): Promise<T> {
		let res: Response;
		try {
			res = await this.fetchImpl(`${this.baseUrl}${path}`, {
				headers: { accept: "application/json" },
			});
		} catch {
			throw new BoardError(null, `board unreachable at ${this.baseUrl}`);
		}
		if (!res.ok)
			throw new BoardError(res.status, `board ${path} -> HTTP ${res.status}`);
		const body = (await res.json()) as T & { ok?: boolean; error?: string };
		if (body.ok === false)
			throw new BoardError(null, body.error ?? "board error");
		return body;
	}
}
