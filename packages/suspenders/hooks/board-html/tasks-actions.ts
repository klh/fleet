// hooks/board-html/tasks-actions.ts — item lifecycle POSTs: start/reassign/unclaim/cancel/retry/second-opinion (W2269.1.3 decompose of tasks.ts;
// same page-global chunk scope — TASKS assembles from the purpose-named pieces).
export const TASKS_ACTIONS = String.raw`
var starting = {}; // 'proj\u0000id' -> start POST in flight (rebuild-proof)
var execPick = {}; // 'proj\u0000id' -> chosen executor (survives card rebuilds)
var cardPending = {}; // 'proj\u0000id' -> verb in flight (W2267.4.2.2: mediator-owned, rebuild-proof)

// Root #103404 — effort drafts are banked the same way (the card's own
// fields die with a structural rebuild; the page maps survive it).
var effortPick = {}; // 'proj\u0000id' -> unsubmitted reasoning-effort pick
function startItem(id, proj, btn, agent, effort){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  var body = { project: proj, id: id, agent: agent || 'claude' };
  if (effort) body.effort = effort; // W183.1 — copilot reasoning-effort dial
  return postJSON('/api/start', body).then(function(j){
    delete starting[k];
    if (j && j.ok) toast('dispatching ' + id + ' on ' + (agent || 'claude') + ' — lane ' + String(j.sid || ''));
    else toast('start failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  }).catch(function(){
    // W2267.4.2.2 — postJSON rejects on timeout/network; without this the
    // starting key stays locked forever (the card's busy state would strand).
    delete starting[k];
    toast('start ' + id + ' failed: network error');
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
  return postJSON('/api/reassign', { project: proj, id: id, agent: agent || 'claude' }).then(function(j){
    delete starting[k];
    if (j && j.ok) toast(j.dispatched === false ? 'old lane signalled to bank + exit — re-dispatch when it retires' : 'reassigning ' + id + ' to ' + (agent || 'claude'));
    else toast('reassign failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  }).catch(function(){
    delete starting[k]; // W2267.4.2.2 — unlock on network failure, never strand
    toast('reassign ' + id + ' failed: network error');
    pollTasks();
  });
}
function unclaimItem(id, proj, btn, force){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  return postJSON('/api/release', { project: proj, id: id, force: !!force }).then(function(j){
    delete starting[k];
    if (j && j.ok) toast('released ' + id + (j.forced ? ' — lane signalled to bank + exit' : ''));
    else if (j && j.live && !force) {
      if (confirm('Lane looks live — force? It will be signalled to bank its capsule and exit.')) return unclaimItem(id, proj, null, true);
      pollTasks();
      return;
    }
    else toast('release failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  }).catch(function(){
    delete starting[k]; // W2267.4.2.2 — unlock on network failure, never strand
    toast('release ' + id + ' failed: network error');
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
// W970/W2267.3 — FAILED-card requeue delegates to the shared recovery
// helpers (actions-retry.ts): retryItem now means recover + fresh attempt.
var retryItem = function(id, proj, btn, force){
  window.__klhRecovery.retryExecItem(id, proj, btn, force, null);
};
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
