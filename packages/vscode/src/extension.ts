// extension.ts — activation wiring: the Tasks + Decisions tree views, the
// status-bar pill and the fleet-task detail document, fed by one polled
// BoardClient. Feed logic lives in model/api/taskdoc (bun-tested); this
// file is the vscode shell.

import * as vscode from "vscode";
import { BoardClient, BoardError } from "./api";
import {
	ageHuman,
	decisionLabel,
	groupByProject,
	shortProject,
	taskDescription,
	taskLabel,
	taskSummary,
	type DecisionRow,
	type DecisionsFeed,
	type TaskRow,
	type TasksFeed,
} from "./model";
import { renderTaskDetail } from "./taskdoc";

const SCHEME = "fleet-task";
const DEFAULT_URL = "http://127.0.0.1:7799";

type TaskElem =
	| { kind: "project"; project: string; n: number }
	| { kind: "task"; row: TaskRow };

class TasksTree implements vscode.TreeDataProvider<TaskElem> {
	private feed: TasksFeed | null = null;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;

	reload(feed: TasksFeed): void {
		this.feed = feed;
		this.changed.fire();
	}

	getTreeItem(el: TaskElem): vscode.TreeItem {
		if (el.kind === "project") {
			const it = new vscode.TreeItem(
				shortProject(el.project),
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			it.description = `${el.n}`;
			return it;
		}
		const it = new vscode.TreeItem(taskLabel(el.row));
		it.description = taskDescription(el.row);
		it.tooltip = taskSummary(el.row);
		it.contextValue = "task";
		it.command = {
			command: "fleet.openTask",
			title: "Open",
			arguments: [el.row],
		};
		return it;
	}

	getChildren(el?: TaskElem): TaskElem[] {
		if (!el) {
			const groups = groupByProject(this.feed?.tasks ?? []);
			return groups.map((g) => ({
				kind: "project" as const,
				project: g.project,
				n: g.rows.length,
			}));
		}
		if (el.kind === "project")
			return (this.feed?.tasks ?? [])
				.filter((r) => r.project === el.project)
				.map((r) => ({ kind: "task" as const, row: r }));
		return [];
	}
}

class DecisionsTree implements vscode.TreeDataProvider<DecisionRow> {
	private feed: DecisionsFeed | null = null;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;

	reload(feed: DecisionsFeed): void {
		this.feed = feed;
		this.changed.fire();
	}

	getTreeItem(d: DecisionRow): vscode.TreeItem {
		const it = new vscode.TreeItem(decisionLabel(d));
		const where = d.task_id ?? (shortProject(d.project ?? "") || "—");
		it.description = `${d.state} · ${ageHuman(d.age_s)} · ${where}`;
		it.tooltip = new vscode.MarkdownString(d.question);
		it.command = {
			command: "fleet.openDecision",
			title: "Open",
			arguments: [d],
		};
		return it;
	}

	getChildren(): DecisionRow[] {
		return this.feed?.decisions ?? [];
	}
}

class FleetStatus {
	private readonly item: vscode.StatusBarItem;
	constructor() {
		this.item = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			50,
		);
		this.item.name = "Fleet";
		this.item.command = "fleet.openBoard";
		this.item.show();
	}

	up(n: number, open: number): void {
		this.item.text = `$(radio-tower) fleet ${n} · ${open}?`;
		this.item.tooltip = new vscode.MarkdownString(
			`${n} live tasks · ${open} OPEN decisions — click to open the board`,
		);
		this.item.backgroundColor = undefined;
	}

	down(msg: string): void {
		this.item.text = `$(radio-tower) fleet $(warning)`;
		this.item.tooltip = new vscode.MarkdownString(`board unreachable: ${msg}`);
		this.item.backgroundColor = new vscode.ThemeColor(
			"statusBarItem.warningBackground",
		);
	}

	dispose(): void {
		this.item.dispose();
	}
}

class TaskDoc implements vscode.TextDocumentContentProvider {
	readonly onDidChange = new vscode.EventEmitter<vscode.Uri>();

	constructor(private readonly getClient: () => BoardClient) {}

	provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		return serveTaskDoc(this.getClient(), uri);
	}

	dispose(): void {
		this.onDidChange.dispose();
	}
}

export function taskDocUri(project: string, id: string): vscode.Uri {
	return vscode.Uri.from({
		scheme: SCHEME,
		path: `/${encodeURIComponent(project)}/${encodeURIComponent(id)}`,
	});
}

async function serveTaskDoc(
	client: BoardClient,
	uri: vscode.Uri,
): Promise<string> {
	const segs = uri.path.split("/").filter(Boolean).map(decodeURIComponent);
	const [project, id] = segs;
	if (!project || !id) return `fleet: malformed task uri — ${uri.toString()}`;
	try {
		return renderTaskDetail(await client.task(project, id));
	} catch (err) {
		return `fleet: ${(err as Error).message}`;
	}
}

export function activate(ctx: vscode.ExtensionContext): void {
	const readCfg = (): { url: string; poll: number } => {
		const c = vscode.workspace.getConfiguration("fleet");
		return {
			url: c.get<string>("boardUrl") ?? DEFAULT_URL,
			poll: c.get<number>("pollSeconds") ?? 15,
		};
	};

	let client = new BoardClient(readCfg().url);
	const tasksTree = new TasksTree();
	const decisionsTree = new DecisionsTree();
	const tasksView = vscode.window.createTreeView("fleet.tasks", {
		treeDataProvider: tasksTree,
	});
	const decView = vscode.window.createTreeView("fleet.decisions", {
		treeDataProvider: decisionsTree,
	});
	const status = new FleetStatus();
	const docs = new TaskDoc(() => client);

	async function cycle(): Promise<void> {
		try {
			const [tf, df] = await Promise.all([client.tasks(), client.decisions()]);
			tasksTree.reload(tf);
			decisionsTree.reload(df);
			tasksView.message = undefined;
			decView.message = undefined;
			status.up(tf.tasks.length, df.count);
		} catch (err) {
			const msg = err instanceof BoardError ? err.message : String(err);
			status.down(msg);
			const view = `board unreachable — check fleet.boardUrl (${msg})`;
			tasksView.message = view;
			decView.message = view;
		}
	}

	let timer: ReturnType<typeof setInterval> | undefined;
	function arm(): void {
		if (timer) clearInterval(timer);
		const poll = readCfg().poll;
		if (poll > 0)
			timer = setInterval(() => {
				void cycle();
			}, poll * 1000);
	}

	function openDetail(project: string | null, id: string | null): void {
		if (!project || !id) return;
		const uri = taskDocUri(project, id);
		vscode.workspace.openTextDocument(uri).then((d) => {
			void vscode.window.showTextDocument(d);
		});
	}

	ctx.subscriptions.push(
		tasksView,
		decView,
		status,
		docs,
		vscode.commands.registerCommand("fleet.refresh", () => {
			void cycle();
		}),
		vscode.commands.registerCommand("fleet.openBoard", () => {
			void vscode.env.openExternal(vscode.Uri.parse(readCfg().url));
		}),
	);

	ctx.subscriptions.push(
		vscode.commands.registerCommand("fleet.openTask", (row?: TaskRow) => {
			if (row) openDetail(row.project, row.id);
		}),
		vscode.commands.registerCommand(
			"fleet.openDecision",
			(row?: DecisionRow) => {
				if (!row) return;
				if (row.project && row.task_id) openDetail(row.project, row.task_id);
				else void vscode.window.showInformationMessage(decisionLabel(row));
			},
		),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration("fleet")) return;
			client = new BoardClient(readCfg().url);
			arm();
			void cycle();
		}),
		{
			dispose: () => {
				if (timer) clearInterval(timer);
			},
		},
	);
	void cycle();
	arm();
}

export function deactivate(): void {}
