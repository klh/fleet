# Fleet setup — reference diagram (2026-11-09)

Sources: C353 verified-path distinctions (ChatGPT lane), docker-desktop runner
receipt v1, kb#6774 NAS schedule, Azure hub architecture amendments (C334/C335).
Live today unless marked PLANNED.

```
                       OWNER (human) — ladder approval slots are human-only
                         │ approve / steer
                         ▼
┌────────────────────── muramasa desktop (macOS arm64) ─────────────────────────┐
│                                                                               │
│  pi lane (01a1bb57) ◄──── consult plane (WS, multi-reader) ────► ChatGPT lane │
│   │ /fleetcockpit (W2887)                (01a186a5, Codex)      fleet lane    │
│   │  tabs: overview·work·local·remote·fiddle                    (5d490283)   │
│   ▼                                                                    ▲      │
│  installed coord ═════════ CONTROL PLANE (single authority) ═══════════╡      │
│   work graph · consults · knowledge sink · lease/epoch · approvals      │      │
│   │                     │                        │                      │      │
│   │ coord workers       │ coord runner list      │ runner API           │      │
│   │ (W2920, live)       │ (C348, live)           │ (owner-scoped)       │      │
│   ▼                     ▼                        ▼                      │      │
│  ┌──────────────────────────────────────────────────────────┐          │      │
│  │ Docker Desktop runner :7810 → controller (lease/epoch)   │          │      │
│  │   → Desktop sandbox + Pi Durable fsynced JSONL (W2923)   │          │      │
│  │   receipt v1: digest-pinned img · TTL bksk_ keys · ro fs  │          │      │
│  └───────────────────────────┬──────────────────────────────┘          │      │
│                              │ per-run inference credential            │      │
│                              ▼                                         │      │
│            Buckle — thin gateway: bksk_ keys · egress guard (loopback │      │
│            CONNECT :4103, fail-closed) · RunnerDriver                 │      │
│                              │                                        │      │
│                              ▼                                        │      │
│            Belt MLX (kev-4b :8901/8902/8903/8906/8912)                │      │
│            GLM-5.3-flash W4A16, Apple-silicon only                    │      │
└───────────────────────────────────────────────────────────────────────┼──────┘
        │ outbound-dial spoke tunnel          NAS = daytime burst host │
        ▼ (prem dials out; never exposes ports)  dark 24:00–07:00 ───────┘
┌─ Azure tier (PLANNED) ────────────────────────────────────────────────┐
│  APIM edge (SSE buffering off) → one hub per GPU node (Kata pods)     │
│  Postgres = program: lease-row-as-truth (INSERT..ON CONFLICT + TTL)   │
│  RunnerDriver: docker | firecracker (prem H100) | azure-containers    │
│  W2924 hub heartbeat (in flight) · hub inventory activation PENDING   │
│  rights[] computed ONLY at the Azure plane                            │
└───────────────────────────────────────────────────────────────────────┘
```

Verified live path (C353): Pi cockpit → installed coord → owner-scoped runner
API / Buckle hub workers → runner controller (lease/epoch) → Desktop sandbox +
Pi Durable fsynced JSONL → per-run inference credential → Buckle → Belt/provider.

Guarded approval GET/POST rides W2922 (locally verified). Never merge the two
governors: federation = mirrored inventory rows + lease handoff, one authority
per plane. Hubs are resources, never containers. Buckle never routes /v1/runs.
