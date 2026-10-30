// methods.ts — W2327: THE dispatch table — method name → handler. One
// shape for everything (design: POST /{package}.{Service}/{Method}, no REST
// verbs); custom methods (v0.1's Message/Steer) join this table, not new
// URL shapes. Handlers take the parsed JSON body and answer data or throw
// DataplaneProblem; the door owns auth, parsing, and problem rendering.

import { z } from "zod";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { listEvents } from "./events.ts";
import { getLane, listLanes } from "./lanes.ts";
import { DataplaneProblem } from "./problems.ts";
import {
	CreateWorkItemRequestSchema,
	DeleteWorkItemRequestSchema,
	LaneMessageRequestSchema,
	LaneSteerRequestSchema,
	parseGetRequest,
	parseListRequest,
	UpdateWorkItemRequestSchema,
} from "./schemas.ts";
import { getWorkItem, listWorkItems } from "./work-items.ts";
import {
	createWorkItem,
	deleteWorkItem,
	messageLane,
	steerViaLane,
	updateWorkItem,
} from "./writes.ts";

export interface MethodContext {
	db: GovernorStore;
	/** The repo root the lane registry resolves from (.fleet parent). */
	fleetRoot: string;
	/** The project identity (governor graph partition key). */
	project: string;
}

export type MethodHandler = (
	ctx: MethodContext,
	body: unknown,
) => unknown | Promise<unknown>;

export interface MethodInfo {
	handler: MethodHandler;
	/** scope the caller's key must hold (READ_ for v0's read-only set). */
	scope: string;
}

const WORK_ITEM_GET = /^projects\/([^/]+)\/workItems\/([^/]+)$/;

/** name → parsed (project, id); the project segment is URL-decoded so a
 *  path-shaped identity round-trips (AIP-122 names are URL-safe). */
const workItemRef = (name: string): { project: string; id: string } => {
	const m = WORK_ITEM_GET.exec(name);
	if (!m)
		throw new DataplaneProblem(
			"invalid_argument",
			`malformed work item name: ${name}`,
		);
	return { project: decodeURIComponent(m[1]), id: m[2] };
};

const withProject = (
	ctx: MethodContext,
	name: string,
): { project: string; id: string } => {
	const ref = workItemRef(name);
	if (ref.project !== ctx.project)
		throw new DataplaneProblem(
			"permission_denied",
			`name outside this graph's project: ${name}`,
		);
	return ref;
};

const methods: Record<string, MethodInfo> = {
	"fleet.work.v1.WorkItems/List": {
		scope: "buckle:dataplane:READ_",
		handler: (ctx, body) => {
			const req = parseListRequest(body);
			if (!req.ok) throw new DataplaneProblem("invalid_argument", req.error);
			return listWorkItems(ctx.db, ctx.project, req.req);
		},
	},
	"fleet.work.v1.WorkItems/Get": {
		scope: "buckle:dataplane:READ_",
		handler: (ctx, body) => {
			const req = parseGetRequest(body);
			if (!req.ok) throw new DataplaneProblem("invalid_argument", req.error);
			const ref = withProject(ctx, req.name);
			return getWorkItem(ctx.db, ref.project, ref.id);
		},
	},
	"fleet.coord.v1.Lanes/List": {
		scope: "buckle:dataplane:READ_",
		handler: (ctx, body) => {
			const req = parseListRequest(body);
			if (!req.ok) throw new DataplaneProblem("invalid_argument", req.error);
			return listLanes(ctx.fleetRoot, req.req);
		},
	},
	"fleet.coord.v1.Lanes/Get": {
		scope: "buckle:dataplane:READ_",
		handler: (ctx, body) => {
			const req = parseGetRequest(body);
			if (!req.ok) throw new DataplaneProblem("invalid_argument", req.error);
			const m = /^lanes\/([^/]+)$/.exec(req.name);
			if (!m)
				throw new DataplaneProblem(
					"invalid_argument",
					`malformed lane name: ${req.name}`,
				);
			return getLane(ctx.fleetRoot, m[1]);
		},
	},
	"fleet.coord.v1.Events/List": {
		scope: "buckle:dataplane:READ_",
		handler: (ctx, body) => {
			const req = parseListRequest(body);
			if (!req.ok) throw new DataplaneProblem("invalid_argument", req.error);
			return listEvents(ctx.db, ctx.project, req.req);
		},
	},
	// ---- v0.1 writes (W2328) — each rides the CLI verb's OWN lib path;
	// the WRITE_ scope is the only added gate
	"fleet.work.v1.WorkItems/Create": {
		scope: "buckle:dataplane:WRITE_",
		handler: (ctx, body) => {
			const req = CreateWorkItemRequestSchema.safeParse(body);
			if (!req.success)
				throw new DataplaneProblem(
					"invalid_argument",
					z.prettifyError(req.error),
				);
			return createWorkItem(ctx.db, ctx.project, req.data);
		},
	},
	"fleet.work.v1.WorkItems/Update": {
		scope: "buckle:dataplane:WRITE_",
		handler: (ctx, body) => {
			const req = UpdateWorkItemRequestSchema.safeParse(body);
			if (!req.success)
				throw new DataplaneProblem(
					"invalid_argument",
					z.prettifyError(req.error),
				);
			return updateWorkItem(ctx.db, ctx.project, req.data);
		},
	},
	"fleet.work.v1.WorkItems/Delete": {
		scope: "buckle:dataplane:WRITE_",
		handler: (ctx, body) => {
			const req = DeleteWorkItemRequestSchema.safeParse(body);
			if (!req.success)
				throw new DataplaneProblem(
					"invalid_argument",
					z.prettifyError(req.error),
				);
			return deleteWorkItem(ctx.db, ctx.project, req.data.name, req.data.note);
		},
	},
	"fleet.coord.v1.Lanes/Message": {
		scope: "buckle:dataplane:WRITE_",
		handler: (_ctx, body) => {
			const req = LaneMessageRequestSchema.safeParse(body);
			if (!req.success)
				throw new DataplaneProblem(
					"invalid_argument",
					z.prettifyError(req.error),
				);
			return messageLane(req.data);
		},
	},
	"fleet.coord.v1.Lanes/Steer": {
		scope: "buckle:dataplane:WRITE_",
		handler: (ctx, body) => {
			const req = LaneSteerRequestSchema.safeParse(body);
			if (!req.success)
				throw new DataplaneProblem(
					"invalid_argument",
					z.prettifyError(req.error),
				);
			return steerViaLane(ctx.fleetRoot, req.data);
		},
	},
};

/** Resolve one method; undefined = unknown (the door answers 404). */
export const resolveMethod = (name: string): MethodInfo | undefined =>
	methods[name];

/** The method names, for the door's index document. */
export const methodNames = (): string[] => Object.keys(methods).sort();
