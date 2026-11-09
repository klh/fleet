import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Run } from "./client.ts";
import type { Snapshot } from "./contracts.ts";
import { executeAction } from "./actions.ts";
import { renderSnapshot, TABS, type Tab } from "./presentation.ts";
import { plain } from "./safe-text.ts";

async function showText(
	ctx: ExtensionCommandContext,
	title: string,
	text: string,
) {
	await ctx.ui.custom<void>((_tui, theme, keybindings, done) => {
		let offset = 0;
		return {
			invalidate() {},
			render(width) {
				const lines = text
					.split("\n")
					.flatMap((line) => wrapTextWithAnsi(plain(line), Math.max(1, width)));
				const height = Math.max(4, (process.stdout.rows ?? 24) - 5);
				offset = Math.min(offset, Math.max(0, lines.length - height));
				return [
					theme.fg("accent", truncateToWidth(plain(title), width)),
					truncateToWidth("Up/Down scroll | Esc close", width),
					...lines.slice(offset, offset + height),
				];
			},
			handleInput(data) {
				if (
					keybindings.matches(data, "tui.select.cancel") ||
					matchesKey(data, "q")
				)
					done();
				else if (matchesKey(data, "down")) offset++;
				else if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
			},
		};
	});
}

async function showOverview(
	ctx: ExtensionCommandContext,
	initial: Tab,
	getSnapshot: () => Snapshot | null,
	refresh: () => Promise<void>,
) {
	let clock: ReturnType<typeof setInterval> | undefined;
	try {
		return await ctx.ui.custom<
			"knowledge" | "consult" | "item" | "consults" | null
		>((tui, theme, keybindings, done) => {
			let tab = initial,
				offset = 0,
				closed = false;
			clock = setInterval(() => tui.requestRender(), 1000); // redraw age only; no data polling
			return {
				invalidate() {},
				render(width) {
					const snapshot = getSnapshot();
					if (!snapshot)
						return [
							truncateToWidth(
								"Fleet data unavailable; r refresh, Esc close",
								width,
							),
						];
					const lines = renderSnapshot(snapshot, tab, width),
						height = Math.max(2, (process.stdout.rows ?? 24) - 10);
					offset = Math.min(offset, Math.max(0, lines.length - 6 - height));
					return [
						theme.fg("accent", lines[0]),
						...lines.slice(1, 6),
						...lines.slice(6 + offset, 6 + offset + height),
					];
				},
				handleInput(data) {
					if (
						keybindings.matches(data, "tui.select.cancel") ||
						matchesKey(data, "q")
					) {
						closed = true;
						done(null);
					} else if (matchesKey(data, "r"))
						void refresh().then(() => {
							if (!closed) tui.requestRender();
						});
					else if (matchesKey(data, "k")) {
						closed = true;
						done("knowledge");
					} else if (matchesKey(data, "c")) {
						closed = true;
						done("consult");
					} else if (matchesKey(data, "i")) {
						closed = true;
						done("item");
					} else if (matchesKey(data, "a")) {
						closed = true;
						done("consults");
					} else if (matchesKey(data, "down")) offset++;
					else if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
					else {
						const i = (["1", "2", "3", "4", "5"] as const).findIndex((key) =>
							matchesKey(data, key),
						);
						if (i >= 0) {
							tab = TABS[i];
							offset = 0;
						}
					}
				},
			};
		});
	} finally {
		if (clock) clearInterval(clock);
	}
}

async function dialog(
	mode: "knowledge" | "consult" | "item" | "consults",
	ctx: ExtensionCommandContext,
	run: Run,
	rawSid: string | null,
	signal?: AbortSignal,
) {
	let request: unknown = { action: mode };
	if (mode === "knowledge") {
		const query = await ctx.ui.input(
			"Search Fleet knowledge",
			"Problem, lesson or capability",
		);
		if (!query) return;
		request = { action: mode, query };
	} else if (mode === "item") {
		const id = await ctx.ui.input("Work item", "W123 or W123.1");
		if (!id) return;
		request = { action: mode, id: id.trim().toUpperCase() };
	} else if (mode === "consult") {
		const peers = await executeAction(
			{ action: "peers" },
			run,
			ctx.cwd,
			rawSid,
			signal,
		);
		if (!peers.actor) throw new Error("Receiver identity is not uniquely live");
		const { PeersSchema } = await import("./contracts.ts");
		const options = PeersSchema.parse(peers.data).filter(
			(p) => p.sid !== peers.actor,
		);
		const labels = options.map(
			(p) => `${plain(p.sessionName ?? p.label)} [${p.sid}]`,
		);
		const selected = await ctx.ui.select("Consult a live peer", labels);
		if (!selected) return;
		const target = options[labels.indexOf(selected)];
		if (!target) return;
		const question = await ctx.ui.input(
			"Question",
			"Include the relevant evidence and desired answer",
		);
		if (!question) return;
		request = { action: mode, target: target.sid, question };
	}
	const result = await executeAction(request, run, ctx.cwd, rawSid, signal);
	const { humanDetails } = await import("./presentation.ts");
	await showText(
		ctx,
		`Fleet ${mode} / ${result.state}`,
		await humanDetails(mode, result),
	);
}

export async function openFleet(
	args: string,
	ctx: ExtensionCommandContext,
	getSnapshot: () => Snapshot | null,
	refresh: () => Promise<void>,
	run: Run,
	rawSid: string | null,
): Promise<void> {
	if (!ctx.hasUI) throw new Error("Use the fleet tool for headless access");
	const command = args.trim();
	const direct = (["knowledge", "consult", "item", "consults"] as const).find(
		(value) => value === command,
	);
	if (direct) {
		await dialog(direct, ctx, run, rawSid);
		return;
	}
	const tab = TABS.find((value) => value === command);
	if (command && !tab)
		throw new Error(
			"Use /fleet [overview|work|routes|attention|peers|knowledge|consult|item|consults]",
		);
	if (!getSnapshot()) await refresh();
	for (;;) {
		const choice = await showOverview(
			ctx,
			tab ?? "overview",
			getSnapshot,
			refresh,
		);
		if (!choice) return;
		await dialog(choice, ctx, run, rawSid);
	}
}
