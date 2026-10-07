# Strays cutover — statusline pair + admission CLI (W542.2)

Post-merge cutover for [W542](https://github.com/klh/fleet): the statusline
pair and the admission CLI live in the repo (`hooks/statusline.ts`,
`hooks/subagent-statusline.ts`, `hooks/bin/admission.ts`) and sync-harness
publishes them (HOOK_ITEMS → prefix root, gate.ts pattern). The historical
`~/.claude` strays are retired; the prefix is the single code source.

## End state (per machine, after `bash install.sh`)

- `settings.json` → `statusLine.command` /
  `subagentStatusLine.command` = `bun $HOME/.claude/hooks/suspenders/{statusline,subagent-statusline}.ts`
  (matches `settings.example.json`).
- `~/.claude/statusline.ts`,
  `~/.claude/hooks/subagent-statusline.ts`,
  `~/.claude/bin/admission.ts` → relative symlinks into
  `~/.claude/hooks/suspenders/…` (the generation-swapping prefix symlink, so
  they survive re-syncs).
- `~/.claude/test/admission.test.ts` deleted — `test/admission.test.ts` in
  the repo is canonical.

## Verify

```bash
eza -la ~/.claude/statusline.ts ~/.claude/hooks/subagent-statusline.ts \
  ~/.claude/bin/admission.ts   # all symlinks, resolve under hooks/suspenders
echo '{"model":{"display_name":"t"},"workspace":{"current_dir":"'"$PWD"'"},"version":"0"}' \
  | bun ~/.claude/hooks/suspenders/statusline.ts   # renders a row
bun test test/admission.test.ts                     # 24/24
```

## Rollback

`git checkout <pre-cutover>` the settings block and re-create the strays from
the repo twins (`cp hooks/statusline.ts ~/.claude/statusline.ts` etc.) — only
needed if the prefix itself must be abandoned; the strays were hash-verified
twins at cutover time (statusline carried the one-line DIM typo the repo
twin already fixed).
