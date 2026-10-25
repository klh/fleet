// src/handlers.ts — wire handlers: the two ingress dialects (POST
// /v1/chat/completions openai-shape, POST /v1/messages anthropic-shape) plus
// /v1/messages/count_tokens and GET /v1/models. SSE responses pass through
// byte-identical (tee, never re-serialized); usage is sniffed from the
// terminal events per the W129 contract (streaming_handler.py semantics,
// MIT port). Errors follow the ingress dialect's error shape; unknown-usage
// streams record requests without token columns — honest omission, never
// estimated.
// W1297 decomposition: the responsibilities above now live in
// purpose-named siblings (app-deps, request-context, wire-stamp,
// wire-deny, proxy-ingress, proxy-execute, proxy-body, usage-record,
// proxy-stream, wire-routes); this barrel re-exports the stable face —
// every importer path stays unchanged.
export type { AppDeps } from "./app-deps.ts";
export { trafficKindOf } from "./request-context.ts";
export { createApp } from "./wire-routes.ts";
