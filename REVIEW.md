# Review contract

Read root and applicable package `AGENTS.md` and `REVIEW.md` from the exact
candidate tree. Follow [how-to-review.md](how-to-review.md): verify mission,
full branch diff and real test evidence; report stable blocking finding IDs.

Fleet's second-opinion runner records an independent machine review against
the exact commit, integration base and instruction hashes. Missing, stale,
failing or unresolved reviews defer merge. DONE records branch completion;
`work.landed` records verified integration separately.

Machine review does not constitute human approval. The high-risk human
review requirements in `how-to-review.md` remain applicable. Fleet has no
trusted human approval receipt interface; a reviewer name or command flag
must never be represented as proof of owner authorization.
