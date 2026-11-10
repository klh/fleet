#!/usr/bin/env bash
set -eu
exported_patch=$1
trial_label=$2
case "$trial_label" in *[!a-zA-Z0-9_-]*|'') exit 2;; esac
oracle_dir=${SWE_ORACLE_DIR:-$(dirname "$0")/private}
candidate_patch="$oracle_dir/$trial_label.patch"
candidate_log="$oracle_dir/$trial_label.log"
test -f "$exported_patch" && test -s "$exported_patch"
(set -C; umask 077; tee "$candidate_patch" < "$exported_patch" >/dev/null)
test -s "$candidate_patch"
image=swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-9461@sha256:7002375c0d6c01c893097a1214c94186f573b15d71d3ead09f50e0d5002deee0
docker run --rm --pull never --platform linux/amd64 --network none --cpus 2 --memory 2g --mount "type=bind,source=$oracle_dir,target=/oracle,readonly" --entrypoint bash "$image" -lc 'cd /testbed; git apply "/oracle/$1.patch" && bash /oracle/eval.sh' benchmark "$trial_label" > "$candidate_log" 2>&1
uv run --no-project --with swebench==4.1.0 python - "$oracle_dir" "$trial_label" <<'PY'
import json,sys
from pathlib import Path
from swebench.harness.grading import get_eval_report
from swebench.harness.test_spec.test_spec import make_test_spec
root,arm=Path(sys.argv[1]),sys.argv[2]
instance=json.loads((root/"instance.json").read_text())
spec=make_test_spec(instance,namespace="swebench")
report=get_eval_report(spec,{"model_patch":(root/f"{arm}.patch").read_text(),"instance_id":instance["instance_id"]},str(root/f"{arm}.log"),True)
row=report[instance["instance_id"]]
print(json.dumps({"resolved":row["resolved"],"tests":{k:{s:len(v) for s,v in group.items()} for k,group in row["tests_status"].items()}}))
PY
