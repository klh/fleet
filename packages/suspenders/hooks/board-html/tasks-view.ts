// hooks/board-html/tasks-view.ts — tasks table view state: sort/filter/grouping (W2269.1.3 decompose of tasks.ts;
// same page-global chunk scope — TASKS assembles from the purpose-named pieces).
export const TASKS_VIEW = String.raw`
// view state: session filter + column sort, persisted per browser (owner
// asked: filter tasks by owning session, sortable table, fragments grouped)
var taskSort = {key: 'priority', dir: 1};
var taskOwner = 'all';
var taskFocus = 'all';
var taskExpanded = false;
try {
  var savedSort = JSON.parse(localStorage.getItem('sb.taskSort') || 'null');
  if (savedSort && savedSort.key) taskSort = savedSort;
  var savedOwner = localStorage.getItem('sb.taskOwner');
  if (savedOwner) taskOwner = String(savedOwner);
  var savedFocus = localStorage.getItem('sb.taskFocus');
  if (['all', 'attention', 'working', 'paused', 'ready', 'waiting'].includes(savedFocus)) taskFocus = savedFocus;
  taskExpanded = localStorage.getItem('sb.taskExpanded') === '1';
} catch (e) {}
function saveTaskView(){
  try { localStorage.setItem('sb.taskSort', JSON.stringify(taskSort)); localStorage.setItem('sb.taskOwner', taskOwner); localStorage.setItem('sb.taskFocus', taskFocus); localStorage.setItem('sb.taskExpanded', taskExpanded ? '1' : '0'); } catch (e) {}
}
function taskSortVal(t, k){
  if (k === 'priority') return taskRank(t);
  if (k === 'age') return Number(t.age_s || 0);
  if (k === 'decisions') return Number(t.open_decisions || 0);
  if (k === 'tok') return Number(t.spend ? t.spend.fresh + t.spend.cached + t.spend.out : 0);
  if (k === 'wall') return Number(t.spend ? t.spend.wall_ms : 0);
  if (k === 'owner') return ownerName(t).toLowerCase();
  if (k === 'proj') return projShort(t.project).toLowerCase();
  var s2 = String(k === 'title' ? t.title : k === 'state' ? t.state : t.id || '');
  return s2.toLowerCase();
}
function sortTasks(arr){
  var k = taskSort.key, d = taskSort.dir;
  arr.sort(function(a, b){
    var va = taskSortVal(a, k), vb = taskSortVal(b, k);
    var cmp = (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    return cmp || Number(a.age_s || 0) - Number(b.age_s || 0);
  });
}
function taskBucket(t){
  var state = displayState(t);
  if (state === 'PAUSED') return 'paused';
  if (state === 'FAILED' || state === 'BLOCKED' || Number(t.open_decisions || 0) > 0) return 'attention';
  if (state === 'CLAIMED' || state === 'RUNNING') return 'working';
  if (state === 'READY') return 'ready';
  return 'waiting';
}
function taskRank(t){
  var bucket = taskBucket(t);
  return bucket === 'attention' ? 0 : bucket === 'working' ? 1 : bucket === 'paused' ? 2 : bucket === 'ready' ? 3 : 4;
}
function taskGroupKey(t){ return String(t.project || '') + '\u0000' + String(t.id); }
// W1211 credential split: a requires csv names a credential scope (gh, az,
// cloud-<provider>, tool-<cli>) — mirrors lib/cred-scope.ts CRED_SCOPE_RE.
function needsCred(csv){
  if (!csv) return false;
  var parts = String(csv).split(',');
  for (var i = 0; i < parts.length; i++)
    if (/^(gh|az|cloud-[a-z0-9][a-z0-9-]*|tool-[a-z0-9][a-z0-9-]*)$/.test(parts[i].trim())) return true;
  return false;
}
function taskGroups(ts){ // fragments nest under their parent row, scoped by project
  var byIdMap = {}, roots = [], kids = {};
  for (var i = 0; i < ts.length; i++) byIdMap[taskGroupKey(ts[i])] = ts[i];
  for (var j = 0; j < ts.length; j++){
    var t = ts[j], id = String(t.id), dot = id.lastIndexOf('.');
    var pid = t.parent_id || (dot > 0 ? id.slice(0, dot) : null);
    var pkey = String(t.project || '') + '\u0000' + pid;
    if (pid && byIdMap[pkey]) (kids[pkey] || (kids[pkey] = [])).push(t);
    else roots.push(t);
  }
  return {roots: roots, kids: kids};
}
function paintSort(){
  var priority = byId('taskPriority');
  if (priority) priority.setAttribute('aria-pressed', taskSort.key === 'priority' ? 'true' : 'false');
  var ths = document.querySelectorAll('#tasksTbl th');
  for (var i = 0; i < ths.length; i++){
    var th = ths[i], k = th.getAttribute('data-k');
    var b = th.querySelector('.thsort');
    if (!k || !b) continue;
    var active = k === taskSort.key;
    th.setAttribute('aria-sort', active ? (taskSort.dir === 1 ? 'ascending' : 'descending') : 'none');
    b.textContent = (b.getAttribute('data-label') || '') + (active ? (taskSort.dir === 1 ? ' \u25B4' : ' \u25BE') : '');
  }
}
`;
