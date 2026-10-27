type NativeShell = { ts: number };
type NativeCall = { ts: number; shellId?: string; shell?: NativeShell };
type NativeRun = { ts: number; text: string };

const DIRECT_TEST =
	/^(?:bun|npm|yarn|pnpm)\s+(?:run\s+)?test\b|^(?:vitest|jest|pytest)\b|^node\s+--test\b|^cargo\s+test\b|^go\s+test\b|^bun\s+(?:--bun\s+)?(?:[^\s"';&|]+\/)?playwright\s+test\b/i;

/** One literal cwd change is allowed; other shell programs cannot relay counts. */
const initiatedTest = (source: string): boolean => {
	const command = source
		.trim()
		.replace(/^cd\s+(?:"[^"]+"|'[^']+'|[^\s"';&|]+)\s*&&\s*/, "");
	return (
		!/[`$<>\r\n]/.test(source) &&
		!/[;&|]/.test(command) &&
		DIRECT_TEST.test(command)
	);
};

const shellIdOf = (value: unknown): string | undefined =>
	typeof value === "string" && /^[\w.-]+$/.test(value) ? value : undefined;

/** Native parallel calls are flattened into individual toolRequests/results.
 * Only an own test bash may establish a shell; reads must name that shell.
 * No accumulated prose, nested result blobs or notification counts are parsed. */
export class CopilotTestEvidence {
	private calls = new Map<string, NativeCall>();
	private shells = new Map<string, NativeShell>();

	request(request: Record<string, unknown>, ts: number): void {
		const id = request.toolCallId;
		if (typeof id !== "string" || !id) return;
		this.calls.delete(id);
		const args = request.arguments as Record<string, unknown> | undefined;
		if (!args || typeof args !== "object") return;
		const shellId = shellIdOf(args.shellId);
		if (request.name === "bash") {
			if (shellId) this.shells.delete(shellId);
			if (typeof args.command === "string" && initiatedTest(args.command))
				this.calls.set(id, { ts });
		} else if (request.name === "read_bash" && shellId) {
			const shell = this.shells.get(shellId);
			if (shell && ts >= shell.ts) this.calls.set(id, { ts, shellId, shell });
		} else if (request.name === "stop_bash" && shellId) {
			this.shells.delete(shellId);
		}
		// Fail closed under an oversized set of unfinished native invocations.
		if (this.calls.size > 256 || this.shells.size > 256) {
			this.calls.clear();
			this.shells.clear();
		}
	}

	complete(data: Record<string, unknown>, ts: number): NativeRun | null {
		const id = data.toolCallId;
		if (typeof id !== "string") return null;
		const call = this.calls.get(id);
		this.calls.delete(id);
		if (!call || ts < call.ts) return null;
		if (call.shellId && this.shells.get(call.shellId) !== call.shell)
			return null;
		const result = data.result as { content?: unknown } | undefined;
		const content = typeof result?.content === "string" ? result.content : "";
		const terminal =
			/<shellId: ([\w.-]+) completed with exit code (\d+)>\s*$/.exec(content);
		if (terminal && call.shellId && terminal[1] !== call.shellId) return null;
		if (data.success !== true || (terminal && terminal[2] !== "0")) {
			if (call.shellId) this.shells.delete(call.shellId);
			return { ts, text: `0 pass\n1 fail\n${content}` };
		}
		if (terminal) {
			if (call.shellId) this.shells.delete(call.shellId);
			return { ts, text: content };
		}
		const running =
			/^<command with shellId: ([\w.-]+) (?:is still running|is running in the background|moved to background)\b/.exec(
				content,
			) ??
			/^<command started in background with shellId: ([\w.-]+)>/.exec(content);
		const shellId = running?.[1];
		if (shellId && (!call.shellId || call.shellId === shellId))
			this.shells.set(shellId, call.shell ?? { ts });
		return null;
	}
}
