import { randomUUID } from "node:crypto";

type Frame = Record<string, unknown>;
type ResponseFrame = {
	type?: string;
	response?: { request_id?: string; subtype?: string; error?: string };
};

export function claudeStreamArguments(args: string[]): {
	prompt: string;
	args: string[];
} {
	const index = args.findIndex((arg) => arg === "-p" || arg === "--print");
	const prompt = args[index + 1];
	if (index < 0 || !prompt || prompt.startsWith("--"))
		throw new Error("managed Claude expects -p <prompt>");
	const rest = args.filter((_, i) => i !== index && i !== index + 1);
	return {
		prompt,
		args: [
			...rest,
			"-p",
			"--verbose",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
		],
	};
}

/** Owns one native stream-json conversation. A positive interrupt response
 * is followed by the interrupted turn's result before the next user input. */
export class ClaudeControl {
	active = false;
	busy = false;
	/** W1035.1: the result frame that closes an interrupted turn is an
	 * internal turn boundary — never a terminal conversation result. The
	 * runtime reads this right after receive() to skip its end-of-session
	 * close on exactly that frame. */
	interruptBoundaryResult = false;
	private closed = false;
	private result: {
		resolve: () => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;
	private requests = new Map<
		string,
		{
			resolve: () => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(
		private send: (frame: Frame) => unknown,
		private timeoutMs = 10_000,
	) {}

	start(text: string): void {
		if (this.closed) throw new Error("Claude control channel closed");
		this.active = true;
		// A new injected turn clears the boundary flag: the next result frame
		// is the real turn end again.
		this.interruptBoundaryResult = false;
		this.send({ type: "user", message: { role: "user", content: text } });
	}

	receive(frame: ResponseFrame): void {
		if (frame.type === "result") {
			// W1035.1: a result arriving while an interrupt is awaited closes the
			// INTERRUPTED turn — an internal boundary, never the conversation's
			// terminal result. The runtime holds its end-of-session close back
			// for exactly one frame when this is set.
			this.interruptBoundaryResult = this.result !== null;
			this.active = false;
			if (this.result) {
				clearTimeout(this.result.timer);
				this.result.resolve();
				this.result = null;
			}
		}
		const id = frame.response?.request_id;
		if (frame.type !== "control_response" || !id) return;
		const pending = this.requests.get(id);
		if (!pending) return;
		this.requests.delete(id);
		clearTimeout(pending.timer);
		if (frame.response?.subtype === "success") pending.resolve();
		else
			pending.reject(
				new Error(frame.response?.error ?? "Claude interrupt refused"),
			);
	}

	async steer(text: string): Promise<void> {
		if (this.busy) throw new Error("Claude interrupt already pending");
		if (this.closed) throw new Error("Claude control channel closed");
		this.busy = true;
		try {
			if (this.active) {
				const result = new Promise<void>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error("Claude interrupted result timed out")),
						this.timeoutMs,
					);
					this.result = { resolve, reject, timer };
				});
				const id = randomUUID();
				const response = new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						this.requests.delete(id);
						reject(new Error("Claude interrupt response timed out"));
					}, this.timeoutMs);
					this.requests.set(id, { resolve, reject, timer });
				});
				this.send({
					type: "control_request",
					request_id: id,
					request: { subtype: "interrupt" },
				});
				await Promise.all([response, result]);
			}
			this.start(text);
		} finally {
			if (this.result) {
				clearTimeout(this.result.timer);
				this.result.resolve();
				this.result = null;
			}
			this.busy = false;
		}
	}

	close(): void {
		this.closed = true;
		for (const request of this.requests.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("Claude control channel closed"));
		}
		this.requests.clear();
		if (this.result) {
			clearTimeout(this.result.timer);
			this.result.reject(new Error("Claude control channel closed"));
			this.result = null;
		}
	}
}
