// hooks/board-html/actions-retry.ts — W2267.3 client recovery actions.
// Retry = recover + fresh attempt (POST /api/retry); Recover → Ready =
// requeue only (POST /api/recover). Card-lane contract: both helpers own
// pending/error UI and board refresh, never open the task drawer — the
// footer delegation returns before the card-open fallthrough. Exposed on
// window.__klhRecovery for Lit-footer consumers (W2269 typed-event lane).
// String chunk: no template literals (String.raw interpolates ${}).
export const ACTIONS_RETRY = String.raw`// --- W2267.3: recovery actions (Retry = fresh attempt, Recover → Ready) ---
var recoveryBusy = {};
function recoveryFinish(k, btn, label){
  delete recoveryBusy[k];
  if (btn) { btn.disabled = false; btn.textContent = label; }
}
function recoveryToast(j, id, attempted){
  if (j && j.ok) {
    // W2267.3 review: report the state the server READ BACK (a requeued
    // item may already be CLAIMED), and say "dispatch requested" — the
    // spawn is unref'd, so dispatched:true proves the request was
    // accepted, never that a worker is provably live.
    var st = String(j.state || 'unknown');
    if (attempted) {
      if (j.dispatched === false) toast('recovered ' + id + ' — ' + st + '; fresh attempt failed: ' + String(j.dispatchError || 'unknown error'));
      else toast('retrying ' + id + ' — recovered to ' + st + ', fresh attempt requested' + (j.sid ? ' (' + j.sid + ')' : ''));
    } else toast('recovered ' + id + ' — ' + st + ', the scheduler picks it up');
    pollTasks();
    return;
  }
  toast((attempted ? 'retry' : 'recover') + ' failed: ' + String((j && j.error) || 'unknown error'));
  pollTasks();
}
function retryExecItem(id, proj, btn, force, agent){
  var k = proj + '\u0000' + id;
  if (recoveryBusy[k]) return; // concurrent/double click cannot spawn twice
  recoveryBusy[k] = true;
  var label = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = 'retrying…'; }
  var body = { project: proj, id: id, force: !!force };
  if (agent) body.agent = agent;
  postJSON('/api/retry', body).then(function(j){
    if (btn) btn.removeAttribute('aria-busy');
    recoveryFinish(k, btn, label);
    if (j && j.operatorGated && !force) {
      if (confirm('Operator-gated item (open NEED_DECISION or operator tag) — force the retry? Auto-dispatch will spawn a lane for it.')) retryExecItem(id, proj, null, true, agent);
      return;
    }
    recoveryToast(j, id, true);
  }).catch(function(){
    // postJSON rejects on timeout/network — without this the button stays
    // disabled and recoveryBusy keeps the key locked forever (review: the
    // unlock must be unconditional, never only on the resolve path).
    if (btn) btn.removeAttribute('aria-busy');
    recoveryFinish(k, btn, label);
    toast('retry ' + id + ' failed: network error');
    pollTasks();
  });
}
function recoverItem(id, proj, btn, force){
  var k = proj + '\u0000' + id;
  if (recoveryBusy[k]) return;
  recoveryBusy[k] = true;
  var label = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = 'recovering…'; }
  postJSON('/api/recover', { project: proj, id: id, force: !!force }).then(function(j){
    if (btn) btn.removeAttribute('aria-busy');
    recoveryFinish(k, btn, label);
    if (j && j.operatorGated && !force) {
      if (confirm('Operator-gated item (open NEED_DECISION or operator tag) — force the recover to READY?')) recoverItem(id, proj, null, true);
      return;
    }
    recoveryToast(j, id, false);
  }).catch(function(){
    if (btn) btn.removeAttribute('aria-busy');
    recoveryFinish(k, btn, label);
    toast('recover ' + id + ' failed: network error');
    pollTasks();
  });
}
window.__klhRecovery = { retryExecItem: retryExecItem, recoverItem: recoverItem };`;
