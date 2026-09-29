# BLAM metrics

Severity axes (per incident record):

- **data_loss_commits** — commits that existed and became unrecoverable.
  The unit of harm for S-class incidents.
- **false_blocks** — legitimate work that was denied/struck/parked
  incorrectly. The unit of alignment cost for A/S-class incidents.
- **wall_clock_lost_min** — minutes from onset to a restored, correct state.
- **undetected_min** — minutes the failure ran before anything noticed.
  Drives the monitoring question: what would have detected this at cost 0?

## Benchmark scoring (BLAM-bench)

Each scenario defines properties and a measurement window. A control plane
under test scores:

- **property satisfaction** (binary per property, per run): e.g. no data
  loss, no false retire, no foreign merge conclusion, debris cleared within
  one cycle.
- **time-to-detect (TTD)** — onset to first correct detection signal.
- **time-to-recover (TTR)** — onset to restored correct state.
- **false-block rate (FBR)** — legitimate actions denied during the window.
- **determinism** — a scenario must reproduce ≥9/10 runs (scripted stand-ins;
  no model calls in the core bench).

A control plane's BLAM score for a scenario suite = (mean property
satisfaction, mean TTD, mean TTR, mean FBR). The bench never compares
control planes on quality of _generated code_ — only on coordination
robustness. Code-quality is explicitly out of scope; MAST covers that
axis for chat-style systems.
