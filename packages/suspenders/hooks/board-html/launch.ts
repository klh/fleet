// hooks/board-html/launch.ts — launch-context section of the task drawer
// (W1240 client chunk). Sits OUTSIDE the sigSet'd drawer body (#taskLaunch
// sibling, W55 pattern): the drawer rebuilds on every good poll and would
// otherwise clobber the textarea's scroll. Keeps its own signature; only
// task changes or fresh launch data rebuild it.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const LAUNCH = String.raw`// --- 4c: launch context (W1240) — what this lane was told ---
var launchCtx = { taskId: null, busy: false, err: null, data: null };
function resetLaunch(){
  if (launchCtx.taskId === task.id) return;
  launchCtx = { taskId: task.id, busy: false, err: null, data: null };
  sigSet(byId('taskLaunch'), 'idle', '');
}
function fetchLaunch(){
  if (launchCtx.busy || launchCtx.err || launchCtx.data) return; // once per open task
  if (!task.id) return;
  var id = task.id;
  var proj = task.proj || (task.data && task.data.task && task.data.task.project);
  if (!proj) return;
  launchCtx.busy = true;
  fetch('/api/task/launch-context?project=' + encodeURIComponent(proj) + '&id=' + encodeURIComponent(id), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { status: r.status, j: j || {} }; }); })
    .then(function(res){
      if (task.id !== id) return; // the drawer moved on
      launchCtx.busy = false;
      if (res.status === 200 && res.j && res.j.ok) launchCtx.data = res.j;
      else launchCtx.err = (res.j && res.j.error) || 'HTTP ' + res.status;
      renderTaskLaunch();
    })
    .catch(function(e){
      if (task.id !== id) return;
      launchCtx.err = String((e && e.message) || e);
      renderTaskLaunch();
    });
}
function renderTaskLaunch(){
  var el = byId('taskLaunch');
  if (!el) return;
  if (!task.id) { sigSet(el, 'idle', ''); return; }
  var sig = [task.id, launchCtx.busy ? 'b' : '', launchCtx.err || '', launchCtx.data ? 'd' : ''].join('|');
  if (el.getAttribute('data-sig') === sig) return;
  el.setAttribute('data-sig', sig);
  var h = '<div class="feed launchfeed"><h2>launch context — what this lane was told</h2>';
  if (launchCtx.data && launchCtx.data.source === 'none') {
    h += '<div class="r dim">no stored launch context (pre-capsule lane)</div>';
  } else if (launchCtx.data) {
    if (launchCtx.data.source === 'item') h += '<div class="r dim">from item fields — no stored brief</div>';
    h += '<textarea id="taskLaunchText" class="launchText" readonly aria-label="launch context — what this lane was told"></textarea>';
  } else if (launchCtx.err) {
    h += '<div class="r dim">launch context unavailable — ' + esc(String(launchCtx.err).slice(0, 120)) + '</div>';
  } else {
    h += '<div class="r dim">loading launch context...</div>';
  }
  h += '</div>';
  // sig is already stamped on the el above — sigSet's own guard would no-op;
  // the W55 sibling chunks stamp + setNodes directly (diff.ts renderTaskDiff).
  setNodes(el, h);
  var ta = byId('taskLaunchText');
  if (ta && launchCtx.data) ta.value = String(launchCtx.data.text || '');
}
`;
