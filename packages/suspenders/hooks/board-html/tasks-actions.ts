// hooks/board-html/tasks-actions.ts — item lifecycle POSTs: start/reassign/unclaim/cancel/retry/second-opinion (W2269.1.3 decompose of tasks.ts;
// same page-global chunk scope — TASKS assembles from the purpose-named pieces).
export const TASKS_ACTIONS = String.raw`
var starting = {}; // 'proj\u0000id' -> start POST in flight (rebuild-proof)
var execPick = {}; // 'proj\u0000id' -> chosen executor (survives card rebuilds)
function startItem(id, proj, btn, agent, effort){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  var body = { project: proj, id: id, agent: agent || 'claude' };
  if (effort) body.effort = effort; // W183.1 — copilot reasoning-effort dial
  postJSON('/api/start', body).then(function(j){
    delete starting[k];
    if (j && j.ok) toast('dispatching ' + id + ' on ' + (agent || 'claude') + ' — lane ' + String(j.sid || ''));
    else toast('start failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  });
}
// W182 — claimed-card lifecycle: reassign (release + re-dispatch on the
// chosen executor, same deterministic sid — capsule IS the handoff) and
// unclaim (release; a live lane 409s {live:true} → confirm offers force,
// which signals it to bank its capsule and exit first).
function reassignItem(id, proj, btn, agent){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  postJSON('/api/reassign', { project: proj, id: id, agent: agent || 'claude' }).then(function(j){
    delete starting[k];
    if (j && j.ok) toast(j.dispatched === false ? 'old lane signalled to bank + exit — re-dispatch when it retires' : 'reassigning ' + id + ' to ' + (agent || 'claude'));
    else toast('reassign failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  });
}
function unclaimItem(id, proj, btn, force){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  postJSON('/api/release', { project: proj, id: id, force: !!force }).then(function(j){
    delete starting[k];
    if (j && j.ok) toast('released ' + id + (j.forced ? ' — lane signalled to bank + exit' : ''));
    else if (j && j.live && !force) {
      delete starting[k];
      if (confirm('Lane looks live — force? It will be signalled to bank its capsule and exit.')) unclaimItem(id, proj, null, true);
      else pollTasks();
      return;
    }
    else toast('release failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  });
}
// W182 — cancel: owner-override close with a required reason (terminal
// CANCELLED; server releases the claim + retires the worktree).
function cancelItem(id, proj, reason, btn){
  if (!reason || !reason.trim()) { toast('cancel needs a reason'); return; }
  if (btn) btn.disabled = true;
  postJSON('/api/cancel', { project: proj, id: id, reason: reason.trim() }).then(function(j){
    if (btn) btn.disabled = false;
    if (j && j.ok) { toast('cancelled ' + id); pollTasks(); if (task.id === id) pollTask(true); }
    else toast('cancel failed: ' + String((j && j.error) || 'unknown error'));
  });
}
// W970 — FAILED-card requeue: /api/retry mirrors the W761 CLI verb;
// operator-gated items (open NEED_DECISION or the 'operator' tag) need a
// force confirm, mirroring unclaim's live-lane confirm.
function retryItem(id, proj, btn, force){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  postJSON('/api/retry', { project: proj, id: id, force: !!force }).then(function(j){
    delete starting[k];
    if (btn) btn.disabled = false;
    if (j && j.ok) { toast('requeued ' + id + ' — READY, dispatch picks it up'); pollTasks(); return; }
    if (j && j.operatorGated && !force) {
      if (confirm('Operator-gated item (open NEED_DECISION or operator tag) — force the requeue to READY? Auto-dispatch will spawn a lane for it.')) retryItem(id, proj, null, true);
      return;
    }
    toast('retry failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  });
}
// W182 — second opinion: spawns a read-only REVIEW lane on the item; the
// verdict lands as a work.review event on the drawer timeline.
function secondOpinion(id, proj, executor, btn){
  if (btn) btn.disabled = true;
  postJSON('/api/second-opinion', { project: proj, id: id, executor: executor }).then(function(j){
    if (btn) btn.disabled = false;
    if (j && j.ok) { toast('second opinion dispatched — ' + executor + ' reviews ' + id); pollTask(true); }
    else toast('second opinion failed: ' + String((j && j.error) || 'unknown error'));
  });
}
`;
