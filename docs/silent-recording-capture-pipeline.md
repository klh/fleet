# Silent screen-recording caption and export pipeline

W552.1 record, 2026-10-11. Scope: capture artifacts only — the pipeline
that turns one real silent screen take into a captioned silent MP4 with
event-timed subtitles, without modifying the raw recording and without
GUI automation or synthetic demo footage.

## Contract

- **Raw preservation**: the raw camera-free take stays outside the
  pipeline's own directories, never overwritten; its absolute path and
  SHA256 are recorded in `receipt.json` next to the export.
- **Event-timed subtitles**: cues are JSON objects with `start`/`end`
  seconds, `event`, `text` and `evidence`; validation requires ordered,
  non-overlapping cues inside the raw duration, non-empty evidence, and
  plain two-line text. Null timings or empty evidence fail closed, so an
  untimed cue can never burn into the export.
- **Silent export**: the burned-caption MP4 is exported with audio
  stripped; the post-export probe refuses any audio stream and any
  duration drift beyond 150 ms against the raw.
- **Typography-only burning**: the installed ffmpeg carries no
  libass/drawtext, so caption bands are rendered as transparent PNG
  overlays (translucent band, white two-line text) and burned with an
  overlay filter; portable SRT and ASS files are written alongside.
- **Keyframe verification**: per-cue midpoint stills (`review-*.png`) are
  extracted from the export for human visual review; keyframes support
  the acceptance check and never replace full-video review.

## Where things live

The exporter, the cue template, per-take cue scaffolds and the labelled
synthetic calibration run live in the private, untracked demo capture
directory under `.fleet/` — repos carry no demo artifacts
(config-over-code law). Exact paths are in the lane done record and the
`finding.w552.1` coord fact.

## State

The pipeline ran end-to-end on 2026-10-07 against a labelled synthetic
calibration clip: receipt records raw SHA256, 4.0 s duration, zero audio
streams, and per-cue review keyframes. The real take is pending the
owner-recorded raw capture (GUI recording is owner-gated); the next
take's cue scaffold is staged fail-closed, so the export command runs
unchanged the moment real footage and its timings exist.
