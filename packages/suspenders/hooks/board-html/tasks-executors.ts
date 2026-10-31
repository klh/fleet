// hooks/board-html/tasks-executors.ts — executor catalog service: live /api/executors catalog, per-card executor pick that survives rebuilds, option builders shared by cards + drawer (W2269.1.3 decompose of tasks.ts;
// same page-global chunk scope — TASKS assembles from the purpose-named pieces).
export const TASKS_EXECUTORS = String.raw`
var execOpts = [
  { value: 'claude', label: 'claude', plane: 'remote', reasoningEffort: false },
  { value: 'codex', label: 'codex', plane: 'remote', reasoningEffort: false },
  { value: 'copilot', label: 'copilot', plane: 'remote', reasoningEffort: true }
];
// W183.1 — bracketed text badges (plain <select>/<option> can't do rich
// icons cross-browser): [L] this machine's swarm, [R] remote/cloud,
// [HUB] prefix added on top when the entry is federation-entitled.
function execBadge(x){
  var loc = x.locality === 'local' || x.plane === 'local' ? 'L' : 'R';
  return (x.plane === 'hub' ? '[HUB] ' : '') + '[' + loc + '] ';
}
var EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function pollExecutors(){
  fetch('/api/executors', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.executors)) return;
      var opts = [];
      var seen = new Set();
      for (var i = 0; i < j.executors.length; i++) {
        var x = j.executors[i];
        if (x && x.value && !seen.has(String(x.value))) {
          seen.add(String(x.value));
          opts.push({
          value: String(x.value), label: String(x.label || x.value),
          locality: String(x.locality || 'remote'), plane: String(x.plane || 'remote'),
          reasoningEffort: !!x.reasoningEffort
          });
        }
      }
      if (opts.length >= 2) execOpts = opts;
      renderKanban(); // repaint cards with the live belt targets
    })
    .catch(function(){}); // dropdown falls back to claude/codex/copilot only
}
// W182 — executor dropdown facts shared by READY + claimed cards: the pick
// survives card rebuilds; options ride the same live executor catalog.
function defaultPick(t){
  var k = t.project + '\u0000' + t.id;
  if (execPick[k]) return execPick[k];
  var prefs = (window.__execPrefs && window.__execPrefs.length) ? window.__execPrefs : ['glm-5.3-flash'];
  for (var pi = 0; pi < prefs.length; pi++) for (var di = 0; di < execOpts.length; di++)
    if (String(execOpts[di].value || '').indexOf(prefs[pi]) >= 0) return execOpts[di].value;
  return 'claude';
}
function execOptions(pick){
  var opts = '';
  for (var xi = 0; xi < execOpts.length; xi++) {
    var xo = execOpts[xi];
    opts += '<option value="' + esc(xo.value) + '"' + (xo.value === pick ? ' selected' : '') + '>' + esc(execBadge(xo) + xo.label) + '</option>';
  }
  return opts;
}
`;
