# Organization knowledge index

The local indexer inventories one GitHub organization with the authenticated
`gh` login. It keeps separate shallow clones of repository default branches in
a private mirror directory. It never changes a developer checkout. Each stored
document has `github:<org>/<repo>:<path>`, a blob SHA, a default-branch commit
SHA, an indexed timestamp, and a source state. Search returns a short excerpt
and a commit-pinned line link. This is an owner-local cache; do not serve the
SQLite database to another principal until query-time source ACL checks exist.

Machine-only `~/.config/klh/knowledge-index.json` (mode 0600):

```json
{
  "org": "example-org",
  "db": "/private/path/knowledge/index.sqlite",
  "mirrors": "/private/path/knowledge/mirrors",
  "batch": 8,
  "filesPerRun": 500
}
```

`bun hooks/bin/org-knowledge-index.ts sync|status|search <query>|stale <id> <reason>`
is the operator interface. `sync` is safe to repeat: a private lock prevents
overlapping runs; every indexed file advances a durable SQLite cursor. A
crashed run resumes from that cursor. The Fleet maintenance sweep fires `sync`
every three minutes when the machine config exists. A machine without the
config skips the task. Branch updates discovered during a partial pass start a
new pass after the old commit is finished; no mixed-commit answer is labeled
current. Deleted files become tombstones. Suspect files are excluded from
search until a later changed source revision is indexed.

The first pass admits architecture and operational documents, source code,
API specifications, package manifests, CI workflows, Docker and deployment
files, infrastructure definitions, and example environment files. Actual
`.env` files and live secret stores are outside its scope. Every search result
is evidence from a source commit, not proof that a deployment target is
running. Runtime claims require live infrastructure observations. Repository
metadata and all knowledge remain private to the authenticated owner.

The index is the changing factual memory. A local specialist model receives
the retrieved snippets with IDs and line links; it must cite, abstain on weak
evidence, and report a stale source. A later LoRA may train that behavior on
reviewed examples. Raw repository content must not be bulk-trained into model
weights: daily source changes, deletion, and access revocation would then be
hard to honor. Architecture and deployment relations can be extracted as
candidate graph edges with their file/line evidence; review or live probes
must confirm them before the consult layer treats them as facts.

Initial completion is visible in `status.repos.current / status.repos.total`.
The org count can exceed the indexable count if some repositories lack a
default branch. The first pass can take hours; measure actual throughput and
disk use rather than using GitHub `diskUsage` as the clone-size estimate.
