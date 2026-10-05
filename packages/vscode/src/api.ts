// api.ts — board client over the v3 read feeds (docs/board-api.md). Zero
// deps: global fetch (extension host Node ≥18) + AbortSignal timeout.

import type {
	ActivityFeed,
	DecisionsFeed,
	TaskDetail,
	TasksFeed,
} from "./model";

export class BoardError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "BoardError";
		this.status = status;
	}
}

const TIMEOUT_MS = 5000;

export class BoardClient {
	private readonly doFetch: typeof fetch;
	constructor(
		readonly baseUrl: string,
		doFetch?: typeof fetch,
	) {
		this.doFetch = doFetch ?? fetch;
	}

	private async get<T>(path: string): Promise<T> {
		let res: Response;
		try {
			res = await this.doFetch(`${this.baseUrl}${path}`, {
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (err) {
			throw new BoardError(
				`board unreachable at ${this.baseUrl}: ${(err as Error).message}`,
				0,
			);
		}
		if (!res.ok)
			throw new BoardError(`board ${res.status} on ${path}`, res.status);
		const body = (await res.json()) as { ok?: boolean; error?: string };
		if (body.ok === false)
			throw new BoardError(
				`board error on ${path}: ${body.error ?? "unknown"}`,
				res.status,
			);
		return body as T;
	}

	tasks(): Promise<TasksFeed> {
		return this.get("/api/tasks");
	}

	task(project: string, id: string): Promise<TaskDetail> {
		return this.get(
			`/api/task?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`,
		);
	}

	decisions(): Promise<DecisionsFeed> {
		return this.get("/api/decisions");
	}

	activity(limit: number): Promise<ActivityFeed> {
		return this.get(`/api/activity?limit=${limit}`);
	}
}
