// Store — turns SessionClient events into view state. Pure helpers (replayTodos, parseTasks,
// activity, columnOf, viewSession, viewItems) are exported so UI and tests can reuse them.
const M = 60000;
export const COLS = [
  { key: 'working', label: '작업 중', color: 'var(--acc)' },
  { key: 'input', label: '입력 필요', color: 'var(--warn)' },
  { key: 'idle', label: '대기', color: 'var(--idle)' },
  { key: 'error', label: '오류', color: 'var(--err)' },
  { key: 'archived', label: '보관', color: 'var(--arch)' },
];
const COL = Object.fromEntries(COLS.map((c) => [c.key, c]));

export const dur = (ms) => {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / M);
  if (m < 1) return `${Math.floor(ms / 1000)}초`;
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일`;
};
export const ago = (ms) => (ms < 60000 ? `${Math.max(1, Math.floor(ms / 1000))}초 전` : `${dur(ms)} 전`);
// Wall-clock time of a message: "오후 2:32" today, with the date on other days (and the year in other years).
export function clock(ms, now) {
  const d = new Date(ms), n = new Date(now);
  const time = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === n.toDateString()) return time;
  return `${d.toLocaleDateString('ko-KR', { ...(d.getFullYear() !== n.getFullYear() && { year: 'numeric' }), month: 'long', day: 'numeric' })} ${time}`;
}
export const proj = (cwd = '') => cwd.split('/').filter(Boolean).pop() || cwd;
export const shortPath = (p = '') => p.replace(/^\/Users\/[^/]+/, '~');
const textOf = (it) => (it.contentItems || []).map((c) => c.text).filter(Boolean).join('\n');

// ── wire normalization (omo app-server) ──
// Thread timestamps arrive as Unix seconds (floats); every view here works in milliseconds.
const toMs = (v) => (typeof v === 'number' && v > 0 && v < 1e12 ? Math.round(v * 1000) : v);
// fileChange kinds arrive as { type: 'add' | 'delete' | 'update' }; the views compare plain strings.
const normChanges = (changes) => (Array.isArray(changes) ? changes.map((c) => (c && c.kind && typeof c.kind === 'object' ? { ...c, kind: c.kind.type || 'update' } : c)) : changes);
const normItem = (i) => (i && i.type === 'fileChange' ? { ...i, changes: normChanges(i.changes) } : i);
const normTurns = (turns) => (turns || []).map((u) => ({ ...u, items: (u.items || []).map(normItem) }));
// History wins, unless live notifications already carry more items for the same turn.
// File history defines membership and order; turns outside its window or branch must not return.
function mergeTurns(hist, live, includeUnseen = true) {
  const byId = new Map((live || []).map((u) => [u.id, u]));
  const out = hist.map((h) => {
    const l = byId.get(h.id);
    byId.delete(h.id);
    return l && (l.items || []).length > (h.items || []).length ? l : h;
  });
  return includeUnseen ? [...out, ...byId.values()] : out;
}
// A running turn that a background result woke (no user message of its own) is also the tail of the file's last turn.
// Tool call ids are the same in both; the agent text just before the first shared call belongs to that same reply.
function withoutLiveTail(fileTurn, live) {
  const ids = new Set(live.items.map((i) => i.id));
  const texts = new Set(live.items.filter((i) => i.type === 'agentMessage').map((i) => i.text));
  let cut = fileTurn.items.findIndex((i) => ids.has(i.id));
  if (cut < 0) cut = fileTurn.items.length;
  while (cut > 0 && fileTurn.items[cut - 1].type === 'agentMessage' && texts.has(fileTurn.items[cut - 1].text)) cut--;
  return { ...fileTurn, items: fileTurn.items.slice(0, cut) };
}
const isEmptyReasoning = (i) => i.type === 'reasoning' && ![...(i.summary || []), ...(i.content || [])].some((s) => String(s || '').trim());

// ── todo replay ──
function applyTodo(phases, a) {
  const P = phases.map((p) => ({ name: p.name, tasks: p.tasks.map((t) => ({ ...t })) }));
  const all = () => P.flatMap((p) => p.tasks);
  const phaseOf = (name) => P.find((p) => p.name === name);
  const targets = () => (a.task != null ? all().filter((t) => t.text === String(a.task)) : a.phase != null ? phaseOf(String(a.phase))?.tasks || [] : []);
  const promote = () => {
    if (all().some((t) => t.status === 'in_progress')) return;
    const next = all().find((t) => t.status === 'pending');
    if (next) next.status = 'in_progress';
  };
  switch (a.op) {
    case 'init':
      if (!Array.isArray(a.list)) throw new Error('bad init');
      return a.list.map((p) => ({ name: String(p?.phase ?? ''), tasks: (Array.isArray(p?.items) ? p.items : []).map((s) => ({ text: String(s), status: 'pending' })) }));
    case 'start': targets().forEach((t) => { t.status = 'in_progress'; }); return P;
    case 'done': targets().forEach((t) => { t.status = 'completed'; }); promote(); return P;
    case 'drop': targets().forEach((t) => { t.status = 'abandoned'; }); return P;
    case 'append': {
      if (!Array.isArray(a.items)) throw new Error('bad append');
      let p = a.phase != null ? phaseOf(String(a.phase)) : P[P.length - 1];
      if (!p) { p = { name: String(a.phase ?? '작업'), tasks: [] }; P.push(p); }
      a.items.forEach((s) => p.tasks.push({ text: String(s), status: 'pending' }));
      return P;
    }
    case 'rm':
      if (a.task != null) P.forEach((p) => { p.tasks = p.tasks.filter((t) => t.text !== String(a.task)); });
      else if (a.phase != null) return P.filter((p) => p.name !== String(a.phase));
      return P;
    case 'view': return P;
    default: throw new Error(`unknown op ${a.op}`);
  }
}
export function replayTodos(items) {
  let phases = null, raw = null, seen = false;
  for (const it of items) {
    if (it.type !== 'dynamicToolCall' || it.tool !== 'todo') continue;
    seen = true;
    let a = it.arguments;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    if (!a || typeof a !== 'object' || typeof a.op !== 'string') { raw = textOf(it) || raw; continue; }
    try { phases = applyTodo(phases || [], a); raw = null; } catch { raw = textOf(it) || raw; }
  }
  if (!seen) return null;
  return { phases: phases || [], raw };
}
export function todoSummary(todo) {
  if (!todo || !todo.phases.length) return null;
  const tasks = todo.phases.flatMap((p) => p.tasks).filter((t) => t.status !== 'abandoned');
  const done = tasks.filter((t) => t.status === 'completed').length;
  const cur = todo.phases.flatMap((p) => p.tasks.map((t) => ({ ...t, phase: p.name }))).find((t) => t.status === 'in_progress')
    || todo.phases.flatMap((p) => p.tasks.map((t) => ({ ...t, phase: p.name }))).find((t) => t.status === 'pending');
  return { done, total: tasks.length, phase: cur?.phase ?? todo.phases[todo.phases.length - 1].name, current: cur?.text ?? '모두 완료' };
}

// ── subagents (omo.task.updated) — every field optional ──
export function parseTasks(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [];
  return list.filter((t) => t && typeof t === 'object').map((t, i) => {
    const live = t.live_progress && typeof t.live_progress === 'object' ? t.live_progress : null;
    const state = t.error_message ? 'error' : live ? 'running' : t.final_response ? 'done' : 'queued';
    return {
      // omo names an unnamed task after its id (st_...), which says nothing about the work; task_summary does.
      id: String(t.task_id ?? t.name ?? i), name: String((t.name !== t.task_id && t.name) || t.task_summary || t.description || t.agent_type || '작업'),
      summary: t.task_summary ? String(t.task_summary) : '', type: String(t.agent_type ?? t.category ?? 'agent'), category: t.category ? String(t.category) : '',
      model: t.model ? String(t.model) : '', childId: t.child_session_id ? String(t.child_session_id) : null,
      activity: live?.activity ? String(live.activity) : '', tool: live?.current_tool ? String(live.current_tool) : '', startedAt: Number(live?.started_at) || null,
      final: t.final_response ? String(t.final_response) : '', error: t.error_message ? String(t.error_message) : '', stats: t.run_stats && typeof t.run_stats === 'object' ? t.run_stats : {}, state,
    };
  });
}

// ── derived thread facts ──
export const allItems = (T) => (T.turns || []).flatMap((u) => u.items || []);
export const currentTurn = (T) => (T.turns || []).find((u) => u.status === 'inProgress');
export function activity(T) {
  const turn = currentTurn(T);
  const live = turn ? [...turn.items].reverse().find((i) => i.status === 'inProgress') : null;
  if (live) {
    switch (live.type) {
      case 'commandExecution': return ['명령 실행 중', live.command || ''];
      case 'fileChange': return ['파일 수정 중', live.changes?.[0]?.path || ''];
      case 'mcpToolCall': return ['도구 호출 중', `${live.server || ''}.${live.tool || ''}`];
      case 'dynamicToolCall': return live.tool === 'request_user_input' ? ['답변 기다리는 중', ''] : ['도구 호출 중', live.tool || ''];
      case 'agentMessage': return ['응답 작성 중', ''];
      case 'reasoning': return ['생각 중', ''];
      case 'webSearch': return ['웹 검색 중', live.query || ''];
      case 'contextCompaction': return ['컨텍스트 압축 중', ''];
      default: return ['작업 중', live.type || ''];
    }
  }
  const st = T.status?.type;
  // A running turn with nothing in progress is waiting on the model: before its first output and between tool calls.
  if (st === 'active' && turn) return ['모델 응답 기다리는 중', ''];
  if (st === 'active') return ['작업 중', ''];
  if (st === 'notLoaded' && T.source === 'cli') return ['터미널에서 실행 중일 수 있음', ''];
  if (st === 'notLoaded') return ['로드되지 않음', ''];
  const last = (T.turns || []).at(-1);
  if (last?.status === 'failed' || st === 'systemError') {
    const cmd = [...(last?.items || [])].reverse().find((i) => i.type === 'commandExecution');
    return ['마지막 턴 실패', cmd?.command || ''];
  }
  if (last?.status === 'interrupted') return ['중단됨', ''];
  return ['대기 중', ''];
}
// The running turn's current step and how long it has lasted, for the timeline's live row and the composer.
export function liveStatus(T, now) {
  const turn = currentTurn(T);
  if (!turn || T.status?.type !== 'active') return null;
  const [label, code] = activity(T);
  return { turnId: turn.id, label, code, elapsed: turn.phaseAt ? dur(now - turn.phaseAt) : '' };
}
export function columnOf(T, reqs) {
  if (T.archived) return 'archived';
  const st = T.status?.type;
  if (reqs.length || (T.status?.activeFlags || []).some((f) => /waitingOn/.test(f))) return 'input';
  if (st === 'systemError' || (st !== 'active' && (T.turns || []).at(-1)?.status === 'failed')) return 'error';
  if (st === 'active') return 'working';
  return 'idle';
}
export const isTerminal = (T) => T.source === 'cli' && !T.subscribed;
export function historyLost(T) {
  if (T.historyFromFile) return false;
  const turns = T.turns || [];
  const done = turns.filter((u) => u.status !== 'inProgress');
  // After an app-server restart, thread/read rebuilds old turns from messages only: no tools, no todo.
  return done.length > 0 && done.every((u) => (u.items || []).every((i) => i.type === 'userMessage' || i.type === 'agentMessage'));
}
function diffStats(diff = '') {
  let add = 0, del = 0;
  for (const l of diff.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) add++; else if (l.startsWith('-') && !l.startsWith('---')) del++; }
  return { add, del };
}
export function diffFiles(diff = '') {
  const files = [];
  let cur = null;
  for (const l of diff.split('\n')) {
    const m = l.match(/^\+\+\+ (?:b\/)?(.+)$/) || null;
    if (l.startsWith('diff --git')) { cur = { path: l.split(' b/').pop(), lines: [] }; files.push(cur); continue; }
    if (m && cur && m[1] !== '/dev/null') cur.path = m[1];
    if (!cur) { cur = { path: '(unknown)', lines: [] }; files.push(cur); }
    cur.lines.push(l);
  }
  return files.filter((f) => f.lines.length).map((f) => ({ path: f.path, ...diffStats(f.lines.join('\n')), text: f.lines.join('\n'), isNew: f.lines.some((l) => l.startsWith('--- /dev/null')), isDel: f.lines.some((l) => l.startsWith('+++ /dev/null')) }));
}

const CELL = {
  completed: { bg: 'var(--acc)', bd: 'var(--acc)' },
  in_progress: { bg: 'var(--acc-tint)', bd: 'var(--acc)' },
  pending: { bg: 'transparent', bd: 'var(--line2)' },
  abandoned: { bg: 'transparent', bd: 'var(--line)' },
  failed: { bg: 'var(--err)', bd: 'var(--err)' },
};
const AG = {
  running: { color: 'var(--acc)', fill: 'var(--acc)', label: '실행 중' },
  done: { color: 'var(--fg2)', fill: 'transparent', label: '완료' },
  error: { color: 'var(--err)', fill: 'var(--err)', label: '오류' },
  queued: { color: 'var(--fg3)', fill: 'transparent', label: '대기' },
};
export const REQ_KIND = {
  'item/commandExecution/requestApproval': '명령 실행 승인',
  'item/fileChange/requestApproval': '파일 변경 승인',
  'item/tool/requestUserInput': '질문',
};

export function viewSession(T, reqs, now) {
  const col = columnOf(T, reqs);
  const c = COL[col];
  const [actLabel, actCode] = activity(T);
  const todo = replayTodos(allItems(T));
  const sum = todoSummary(todo);
  const failed = col === 'error';
  const lastErr = T.lastError || (T.turns || []).at(-1)?.error?.message || '';
  const o = {
    id: T.id, name: T.name || T.preview?.slice(0, 30) || '이름 없는 세션', cwd: shortPath(T.cwd), projectName: proj(T.cwd),
    model: (T.settings?.model || '').replace(/^.*\//, ''), col, statusColor: c.color, statusLabel: col === 'idle' && T.status?.type && !['idle', 'notLoaded'].includes(T.status.type) ? T.status.type : c.label,
    elapsed: dur(now - (T.createdAt || now)), updatedAgo: ago(now - (T.updatedAt || now)), actLabel, actCode,
    // A collapsed card shows one time. Columns are ordered by last activity, so resting sessions show that; running and
    // waiting ones keep their age.
    ...(col === 'working' || col === 'input'
      ? { headTime: dur(now - (T.createdAt || now)), headTitle: '만든 뒤 지난 시간' }
      : { headTime: ago(now - (T.updatedAt || now)), headTitle: '마지막 활동' }),
    terminal: isTerminal(T), lost: historyLost(T) && !todo, hasError: failed && !!lastErr, error: lastErr,
    subscribed: !!T.subscribed, archived: !!T.archived,
  };
  if (sum) {
    const failedTurn = failed;
    o.phases = todo.phases.map((p) => {
      const tasks = p.tasks.filter((t) => t.status !== 'abandoned');
      const d = tasks.filter((t) => t.status === 'completed').length;
      const cur = p.tasks.some((t) => t.status === 'in_progress');
      return {
        name: p.name, flex: `${Math.max(1, tasks.length)} 1 0`, count: `${d}/${tasks.length}`, pct: `${tasks.length ? (d / tasks.length) * 100 : 0}%`,
        fill: cur && failedTurn ? 'var(--err)' : 'var(--acc)', nameColor: cur ? 'var(--fg)' : d === tasks.length ? 'var(--fg2)' : 'var(--fg3)',
        cells: tasks.map((t) => (failedTurn && t.status === 'in_progress' ? CELL.failed : CELL[t.status] || CELL.pending)),
      };
    });
    Object.assign(o, { hasTodo: true, todoText: `${sum.done}/${sum.total}`, phaseName: sum.phase, currentTask: sum.current, todoRaw: todo.raw || '' });
  } else Object.assign(o, { hasTodo: false, phases: [], todoRaw: todo?.raw || '' });
  const tasks = T.tasks || [];
  const agentView = (t) => ({ ...t, ...AG[t.state], stateLabel: AG[t.state].label,
    act: t.state === 'running' ? [t.activity, t.tool, t.startedAt && dur(now - t.startedAt)].filter(Boolean).join(' · ') : t.state === 'done' ? `완료${t.stats?.duration_ms ? ` · ${dur(t.stats.duration_ms)}` : ''}${t.stats?.tool_calls ? ` · 도구 ${t.stats.tool_calls}회` : ''}` : t.error || '대기 중' });
  // Finished subagents (done or failed) leave the cards; the session's agents tab keeps them behind a toggle.
  const ended = (t) => t.state === 'done' || t.state === 'error';
  o.agents = tasks.filter((t) => !ended(t)).map(agentView);
  o.doneAgents = tasks.filter(ended).map(agentView);
  o.hasAgents = o.agents.length > 0;
  const n = (s) => tasks.filter((t) => t.state === s).length;
  o.agentSummary = [n('running') && `실행 ${n('running')}`, n('queued') && `대기 ${n('queued')}`].filter(Boolean).join(' · ');
  const r = reqs[0];
  o.hasReq = !!r;
  o.isApproval = !!r && r.method !== 'item/tool/requestUserInput';
  o.isQuestion = !!r && r.method === 'item/tool/requestUserInput';
  o.reqCount = reqs.length;
  if (r) {
    const p = r.params || {};
    o.reqId = r.id;
    o.reqKind = r.method === 'item/tool/requestUserInput' ? `질문 ${(p.questions || []).length}개` : REQ_KIND[r.method] || '승인 요청';
    o.reqCode = p.command || (p.changes || []).map((ch) => `${ch.kind === 'delete' ? '삭제' : ch.kind === 'add' ? '추가' : '수정'} ${ch.path}`).join(', ') || '';
    o.reqText = (p.questions || []).map((q) => q.question).join(' · ');
    o.reqShort = o.reqCode || (p.questions || []).map((q) => q.header || q.question).join(' · ');
    o.countdown = countdown(r, now);
  } else Object.assign(o, { reqKind: '', reqCode: '', reqText: '', reqShort: '', countdown: '' });
  o.usage = T.usage || null;
  return o;
}
export function countdown(r, now) {
  const t = r.params?.timeoutMs;
  if (!t) return '';
  const left = Math.max(0, r.receivedAt + t - now);
  return `${Math.floor(left / M)}:${String(Math.floor((left % M) / 1000)).padStart(2, '0')} 남음`;
}

// ── pasted images ──
// Images travel as file paths in the message text (app-server's turn input rejects image items) and the agent opens
// them with its read tool. The block is parsed back out so the timeline shows thumbnails instead of the paths.
export const IMAGES_HEAD = 'Attached images (open each with the read tool before answering):';
export const withImages = (text, paths = []) => (paths.length ? [text, [IMAGES_HEAD, ...paths.map((p) => `- ${p}`)].join('\n')].filter(Boolean).join('\n\n') : text);
// Image files from a paste, drop or file picker. For pastes, text on the clipboard wins: apps like Excel and Docs also
// put a picture of the selection there.
export function imageFiles(dt, { textWins = false } = {}) {
  if (!dt || (textWins && (dt.getData?.('text/plain') || '').trim())) return [];
  const fromItems = [...(dt.items || [])].filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
  return fromItems.length ? fromItems : [...(dt.files || [])].filter((f) => f.type.startsWith('image/'));
}
const UPLOAD_NAME = /\/\.omonitor\/uploads\/([0-9a-f-]{36}\.(?:png|jpg|gif|webp))$/;
export function splitImages(text = '') {
  const i = text.lastIndexOf(IMAGES_HEAD);
  if (i < 0) return { text, images: [] };
  const paths = text.slice(i + IMAGES_HEAD.length).split('\n').map((l) => l.match(/^- (.+)$/)?.[1]?.trim()).filter(Boolean);
  return { text: text.slice(0, i).trim(), images: paths.map((path) => ({ path, url: path.match(UPLOAD_NAME) ? `/uploads/${path.match(UPLOAD_NAME)[1]}` : '' })) };
}

// ── timeline items ──
export function viewItems(T, now = Date.now()) {
  const out = [];
  const live = liveStatus(T, now);
  (T.turns || []).forEach((u, ti) => {
    const label = { inProgress: '진행 중', completed: '완료', failed: '실패', interrupted: '중단됨' }[u.status] || u.status || '';
    out.push({ key: `turn-${u.id}`, isTurn: true, text: `턴 ${ti + 1}`, meta: label, metaColor: u.status === 'failed' ? 'var(--err-fg)' : u.status === 'inProgress' ? 'var(--acc-fg)' : 'var(--fg3)' });
    (u.items || []).filter((i) => !isEmptyReasoning(i)).forEach((i) => out.push(viewItem(i)));
    if (live?.turnId === u.id) out.push({ key: `live-${u.id}`, isLive: true, text: live.label, code: live.code, hasCode: !!live.code, meta: live.elapsed });
    if (u.error?.message) out.push({ key: `err-${u.id}`, isError: true, text: u.error.message });
    // A finished turn ends with the time of its last message (file history: lastAt; live: last item event).
    const at = u.lastAt || toMs(u.completedAt);
    if (u.status !== 'inProgress' && at) out.push({ key: `at-${u.id}`, isTime: true, text: clock(at, now), title: new Date(at).toLocaleString('ko-KR') });
  });
  return out;
}
function viewItem(i) {
  const base = { key: i.id, status: i.status || 'completed', live: i.status === 'inProgress', declined: i.status === 'declined', interrupted: i.status === 'interrupted' };
  switch (i.type) {
    case 'userMessage': {
      const { text, images } = splitImages((i.content || []).map((c) => c.text).filter(Boolean).join('\n'));
      return { ...base, isUser: true, text, hasText: !!text, hasImages: images.length > 0,
        images: images.map((m, k) => ({ ...m, key: String(k), hasUrl: !!m.url, noUrl: !m.url, name: m.path.split('/').pop() })) };
    }
    case 'agentMessage': return { ...base, isAgent: true, text: i.text || '' };
    case 'reasoning': return { ...base, isReason: true, text: [...(i.summary || []), ...(i.content || [])].join('\n') || '…' };
    case 'commandExecution': {
      const out = i.aggregatedOutput || '';
      return { ...base, isCmd: true, cmd: i.command || '', cwd: shortPath(i.cwd || ''), exitCode: i.exitCode, ok: i.exitCode === 0 || i.exitCode == null,
        meta: [i.exitCode != null && `exit ${i.exitCode}`, i.durationMs && `${(i.durationMs / 1000).toFixed(1)}s`, base.declined && '거절됨', base.interrupted && '중단됨'].filter(Boolean).join(' · ') || (base.live ? '실행 중' : ''),
        lines: out ? out.split('\n') : [] };
    }
    case 'fileChange': {
      const ch = i.changes || [];
      const files = ch.map((c) => ({ path: c.path, kind: c.kind, ...diffStats(c.diff || ''), lines: (c.diff || '').split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file)/.test(l)) }));
      return { ...base, isFile: true, files };
    }
    case 'dynamicToolCall': {
      if (i.tool === 'todo') {
        const a = typeof i.arguments === 'object' && i.arguments ? i.arguments : {};
        const t = { init: `todo 작성 · ${(a.list || []).length}단계 ${(a.list || []).reduce((n, p) => n + (p.items || []).length, 0)}개`, done: `완료 · ${a.task ?? a.phase ?? ''}`, start: `시작 · ${a.task ?? a.phase ?? ''}`, drop: `포기 · ${a.task ?? a.phase ?? ''}`, append: `추가 · ${(a.items || []).join(', ')}`, rm: `삭제 · ${a.task ?? a.phase ?? ''}`, view: '목록 확인' }[a.op];
        return { ...base, isTodo: true, glyph: a.op === 'done' ? '✓' : a.op === 'init' ? '≡' : a.op === 'drop' ? '×' : '+', text: t || textOf(i) || 'todo' };
      }
      const detail = i.arguments?.summary || i.arguments?.path || '';
      return { ...base, isTool: true, text: `${i.tool}${detail ? ` · ${detail}` : ''}`, result: textOf(i), failed: i.success === false };
    }
    case 'mcpToolCall': return { ...base, isTool: true, text: `${i.server}.${i.tool}`, result: (i.result?.content || []).map((c) => c.text).join('\n') };
    case 'webSearch': return { ...base, isTool: true, text: `웹 검색 · ${i.query || ''}` };
    case 'contextCompaction': return { ...base, isCompact: true, text: base.live ? '컨텍스트 압축 중…' : '컨텍스트를 압축했습니다' };
    default: return { ...base, isTool: true, text: i.type || 'item' };
  }
}

// model/list names a model "provider/id"; thread responses return model and modelProvider separately.
const modelRef = (model, provider) => (model && provider && provider !== 'unknown' ? `${provider}/${model}` : model || '');

// ── Store ──
export class Store {
  constructor(client) {
    this.c = client;
    this.v = 0;
    this.fns = new Set();
    this.s = { conn: { state: 'closed' }, loading: true, threads: new Map(), requests: new Map(), models: [], skills: [], toasts: [], resolved: [], notify: { browser: true, sound: false } };
    this.msgAt = new Map(); // thread id → last conversation time (ms) from the session file, via the backend
    client.on('notification', (n) => this.onNote(n));
    client.on('serverRequest', (r) => this.onReq(r));
    client.on('connection', (e) => this.onConn(e));
    this.raf = 0;
  }
  subscribe(fn) { this.fns.add(fn); return () => this.fns.delete(fn); }
  emit() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.v++; this.fns.forEach((f) => f(this.v)); });
  }
  toast(text, kind = 'error') {
    const t = { id: Math.random().toString(36).slice(2), text, kind };
    this.s.toasts = [...this.s.toasts, t];
    this.emit();
    setTimeout(() => { this.s.toasts = this.s.toasts.filter((x) => x.id !== t.id); this.emit(); }, 5000);
  }
  async guard(p, label) {
    try { return await p; } catch (e) { this.toast(`${label}: ${e?.message || e}`); throw e; }
  }
  T(id) { return this.s.threads.get(id); }
  reqsFor(id) { return [...this.s.requests.values()].filter((r) => r.params?.threadId === id); }

  async init() {
    await this.c.connect();
    await this.bootstrap();
  }
  async listAll(archived) {
    const out = [];
    let cursor = null;
    do { const r = await this.c.request('thread/list', { archived, cursor, limit: 50 }); out.push(...(r.data || [])); cursor = r.nextCursor; } while (cursor);
    return out;
  }
  async bootstrap() {
    const talked = this.c.backend?.activity?.().catch((e) => { console.warn('[omonitor] 세션 파일에서 마지막 대화 시각을 읽지 못했습니다:', e?.message || e); return {}; });
    const [active, archived, models, loaded, msgAt] = await Promise.all([this.listAll(false), this.listAll(true), this.c.request('model/list').catch(() => ({ data: [] })), this.c.request('thread/loaded/list').catch(() => ({ data: [] })), talked]);
    this.msgAt = new Map(Object.entries(msgAt || {}));
    for (const t of [...active, ...archived.map((t) => ({ ...t, archived: true }))]) this.merge(t);
    this.s.models = models.data || [];
    this.c.backend?.extraModels?.().then((xs) => {
      const have = new Set(this.s.models.map((m) => m.id));
      this.s.models = [...this.s.models, ...(xs || []).filter((m) => !have.has(m.id))];
      this.emit();
    }).catch((e) => console.warn('[omonitor] Claude 구독 모델 목록을 읽지 못했습니다:', e?.message || e));
    this.s.loading = false;
    this.emit();
    // Subscribe only to threads the app-server already has loaded. Loading a saved thread (thread/resume or thread/read)
    // starts its agent runtime, and omo may auto-continue a pending goal or todo list; unloaded history comes from the
    // session file through the backend instead (loadHistory).
    for (const id of loaded.data || []) if (this.T(id) && !this.T(id).archived) this.resume(id, true).catch(() => {});
    this.c.backend?.listSkills?.().then((sk) => { this.s.skills = sk || []; this.emit(); }).catch(() => {});
  }
  merge(t) {
    const prev = this.s.threads.get(t.id) || { turns: [], tasks: [], goal: null, subscribed: false, settings: {} };
    const next = { ...prev, ...t };
    for (const k of ['createdAt', 'updatedAt', 'recencyAt']) if (k in t) next[k] = toMs(t[k]);
    // app-server's updatedAt follows the session file's last entry, which also moves when a session is merely loaded
    // (omo appends metadata). The backend reads the last conversation time instead; live events seen here are newer.
    const talkedAt = this.msgAt.get(t.id);
    if (talkedAt != null && 'updatedAt' in t) next.updatedAt = Math.max(talkedAt, prev.liveAt || 0);
    next.turns = t.turns ? normTurns(t.turns) : prev.turns;
    this.s.threads.set(t.id, next);
    return next;
  }
  async resume(id, silent, reloadHistory) {
    const p = this.c.request('thread/resume', { threadId: id });
    const r = await (silent ? p : this.guard(p, '세션을 불러오지 못했습니다'));
    // thread/resume never carries history (turns: []); keep what is already here and fetch history separately.
    const { turns, ...thread } = r.thread || {};
    this.merge({ ...thread, subscribed: true, loaded: true, settings: { model: modelRef(r.model, r.modelProvider), effort: r.reasoningEffort } });
    this.c.request('thread/goal/get', { threadId: id }).then((g) => { const T = this.T(id); if (T) { T.goal = g.goal || null; this.emit(); } }).catch(() => {});
    if (reloadHistory || !this.T(id).historyLoaded) await this.loadHistory(id).catch(() => {});
    this.emit();
    return this.T(id);
  }
  // Notifications sent while the socket was down are lost, and resume keeps the turns already on screen, so a reconnect
  // re-reads what a page load reads: the thread list, then subscriptions and history for subscribed and loaded threads.
  async resync() {
    const subs = new Set();
    for (const T of this.s.threads.values()) {
      if (T.subscribed) { subs.add(T.id); T.subscribed = false; }
      else if (T.historyLoaded) T.historyLoaded = false; // read again from the session file when opened next
    }
    try {
      const [active, archived, loaded, msgAt] = await Promise.all([this.listAll(false), this.listAll(true), this.c.request('thread/loaded/list').catch(() => ({ data: [] })), this.c.backend?.activity?.().catch(() => null)]);
      if (msgAt) this.msgAt = new Map(Object.entries(msgAt));
      // List entries carry no history (turns: []); the timeline on screen stays until loadHistory replaces it.
      for (const { turns, ...t } of [...active, ...archived.map((t) => ({ ...t, archived: true }))]) this.merge(t);
      for (const id of loaded.data || []) if (this.T(id) && !this.T(id).archived) subs.add(id);
    } catch (e) { console.warn('[omonitor] 다시 연결한 뒤 세션 목록을 읽지 못했습니다:', e?.message || e); }
    this.emit();
    await Promise.all([...subs].map((id) => this.resume(id, true, true).catch(() => {})));
  }
  // History comes from the session file through the backend: it is the complete record, and reading it has no side
  // effects, while thread/read loads an unloaded thread (omo may then auto-continue it) and, for a loaded thread, only
  // returns turns from the app-server's own lifetime. A running turn is taken from the app-server so live notifications
  // keep extending the same turn id.
  async loadHistory(id) {
    const T = this.T(id);
    if (!T) return;
    const read = async () => (await this.c.request('thread/read', { threadId: id, includeTurns: true })).thread?.turns || [];
    const fromFile = !!this.c.backend?.history;
    let turns = fromFile ? await this.c.backend.history(id) : await read();
    let live = null;
    if (fromFile && T.status?.type !== 'notLoaded') {
      live = (await read()).find((u) => u.status === 'inProgress');
      const userText = (u) => (u?.items || []).find((i) => i.type === 'userMessage')?.content?.map((c) => c.text).join('\n') || '';
      const last = turns.at(-1);
      if (live) turns = [...turns.slice(0, -1), ...(!last || (userText(last) && userText(last) === userText(live)) ? [] : [withoutLiveTail(last, live)]), live];
    }
    const cur = this.T(id);
    if (!cur) return;
    // File turns start at user messages, app-server turns at every agent run, so their ids never match. Turns kept from
    // live notifications are already inside the file history, except the running one.
    cur.turns = mergeTurns(normTurns(turns), fromFile ? cur.turns.filter((u) => u.id.startsWith('file-') || u.id === live?.id) : cur.turns, !fromFile);
    Object.assign(cur, { historyLoaded: true, historyFromFile: fromFile });
    this.emit();
    this.loadMeta(id);
  }
  // Settles an idle report that arrived without turn/completed by reading the thread's status back. The thread is loaded
  // (it reported idle), so thread/read has no side effects here.
  verifyStatus(id) {
    setTimeout(async () => {
      if (!this.T(id)?.pendingStatus) return; // turn/completed or a new item already settled it
      let status = null;
      try { status = (await this.c.request('thread/read', { threadId: id, includeTurns: false })).thread?.status || null; } catch {}
      const T = this.T(id);
      if (T?.pendingStatus) { T.status = status || T.pendingStatus; T.pendingStatus = null; this.emit(); }
    }, 500);
  }
  // Subagent runs and context usage come from the session file; app-server sends neither.
  loadMeta(id) {
    if (!this.c.backend?.meta) return;
    this.c.backend.meta(id).then((m) => {
      const T = this.T(id);
      if (!T || !m) return;
      if (m.agents?.length || !T.tasks?.length) T.tasks = parseTasks(m.agents || []);
      if (m.usage) T.usage = m.usage;
      this.emit();
    }).catch((e) => console.warn('[omonitor] 세션 파일에서 에이전트·컨텍스트 정보를 읽지 못했습니다:', e?.message || e));
  }
  onConn(e) {
    this.s.conn = e;
    if (e.state === 'open' && e.reconnected) {
      this.resync();
      this.toast('다시 연결했습니다. 구독을 복구합니다.', 'info');
    }
    if (e.state === 'reconnecting') this.s.requests.clear();
    this.emit();
  }
  onReq(r) {
    this.s.requests.set(r.id, { ...r, params: r.params?.changes ? { ...r.params, changes: normChanges(r.params.changes) } : r.params, receivedAt: Date.now() });
    const T = this.T(r.params?.threadId);
    this.alert(T, r);
    this.emit();
  }
  alert(T, r) {
    const title = `${T?.name || '세션'} · ${REQ_KIND[r.method] || '요청'}`;
    if (this.s.notify.browser && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      try { new Notification(title, { body: r.params?.command || r.params?.questions?.[0]?.question || '' }); } catch {}
    }
    if (this.s.notify.sound) {
      try {
        const ctx = (this.ac = this.ac || new AudioContext());
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; g.gain.setValueAtTime(0.06, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
        o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.26);
      } catch {}
    }
  }
  turnFor(T, turnId) {
    let u = T.turns.find((x) => x.id === turnId);
    if (!u) { u = { id: turnId, status: 'inProgress', items: [] }; T.turns = [...T.turns, u]; }
    return u;
  }
  onNote({ method, params: p = {} }) {
    const T = p.threadId ? this.T(p.threadId) : null;
    switch (method) {
      case 'thread/started': { const { turns, ...t } = p.thread || {}; if (t.id) this.merge(t); } break;
      case 'thread/status/changed': if (T) {
        // Starting or finishing a turn is activity; the status a session reports when it is loaded or subscribed is not.
        const was = T.status?.type;
        if (p.status?.type === 'active' || was === 'active') T.updatedAt = T.liveAt = Date.now();
        // Any client subscribing to a busy thread (thread/resume) makes app-server broadcast "idle" while the turn keeps
        // running. A real end of turn comes with turn/completed, so a drop from active waits for it (or is read back)
        // instead of flipping the session to idle.
        if (was === 'active' && p.status?.type === 'idle') { T.pendingStatus = p.status; this.verifyStatus(T.id); }
        else { T.status = p.status; T.pendingStatus = null; }
        if (p.status?.type === 'active' && !T.subscribed && !T.archived) this.resume(T.id, true).catch(() => {});
      } break;
      case 'thread/archived': if (T) { T.archived = true; T.subscribed = false; } break;
      case 'thread/closed': if (T) T.subscribed = false; break;
      case 'thread/deleted': this.s.threads.delete(p.threadId); for (const r of this.reqsFor(p.threadId)) this.s.requests.delete(r.id); break;
      case 'thread/name/updated': if (T) T.name = p.threadName ?? p.name; break;
      case 'thread/settings/updated': if (T && p.threadSettings) T.settings = { model: modelRef(p.threadSettings.model, p.threadSettings.modelProvider), effort: p.threadSettings.effort }; break;
      case 'thread/goal/updated': if (T) T.goal = p.goal; break;
      case 'thread/goal/cleared': if (T) T.goal = null; break;
      case 'thread/unarchived': if (T) T.archived = false; break;
      case 'thread/tokenUsage/updated': if (T) T.usage = { used: p.tokenUsage?.total?.totalTokens ?? 0, window: p.tokenUsage?.modelContextWindow ?? 0 }; break;
      // A subagent's completion wakes its parent with a new turn, so turn starts refresh the agents tab too.
      case 'turn/started': if (T) { const u = this.turnFor(T, p.turn.id); u.status = 'inProgress'; u.phaseAt = Date.now(); T.diff = ''; this.loadMeta(T.id); } break;
      case 'turn/completed': if (T) { const u = this.turnFor(T, p.turn.id); u.status = p.turn.status; u.lastAt ||= Date.now(); if (T.pendingStatus) { T.status = T.pendingStatus; T.pendingStatus = null; } if (p.turn.items?.length) u.items = p.turn.items.map(normItem); if (p.turn.error) { u.error = p.turn.error; T.lastError = p.turn.error.message; } this.loadMeta(T.id); } break;
      case 'item/started': case 'item/completed': if (T) {
        const u = this.turnFor(T, p.turnId);
        const item = normItem(p.item);
        // Items only start inside a running turn, whatever status was last broadcast.
        if (method === 'item/started') { T.pendingStatus = null; if (T.status?.type !== 'active') T.status = { type: 'active', activeFlags: [] }; }
        // omo sends reasoning and agentMessage items without a status; the event itself says whether the item is running.
        if (item.status == null) item.status = method === 'item/started' ? 'inProgress' : 'completed';
        const i = u.items.findIndex((x) => x.id === item.id);
        u.items = i >= 0 ? u.items.map((x, k) => (k === i ? { ...x, ...item } : x)) : [...u.items, item];
        T.updatedAt = T.liveAt = u.phaseAt = u.lastAt = Date.now();
        // Subagent spawns and control calls (task, task_cancel, ...) change the agents tab.
        if (method === 'item/completed' && item.type === 'dynamicToolCall' && /^task/.test(item.tool || '')) this.loadMeta(T.id);
      } break;
      case 'item/agentMessage/delta': if (T) {
        const u = this.turnFor(T, p.turnId);
        u.items = u.items.map((x) => (x.id === p.itemId ? { ...x, text: (x.text || '') + p.delta } : x));
      } break;
      // omo streams each thinking block into its own reasoning item (contentIndex is the block's place in the model
      // output, not an index into the item), so the text accumulates in content[0] until item/completed replaces it.
      case 'item/reasoning/textDelta': if (T) {
        const u = this.turnFor(T, p.turnId);
        u.items = u.items.map((x) => (x.id === p.itemId ? { ...x, content: [((x.content || [])[0] || '') + p.delta] } : x));
      } break;
      case 'turn/diff/updated': if (T) T.diff = p.diff || ''; break;
      case 'error': {
        const msg = p.error?.message || p.message || (typeof p.error === 'string' ? p.error : '');
        // omo also reports extension diagnostics here ({ extensionPath, event, error }); they carry no threadId.
        if (!p.threadId) { console.warn('[omo app-server]', p.extensionPath || '', msg); break; }
        if (T) T.lastError = msg || '알 수 없는 오류';
        if (!p.willRetry) this.toast(msg || '서버 오류');
        break;
      }
      case 'extension_event': if (T && p.name === 'omo.task.updated') T.tasks = parseTasks(p.data); break;
      case 'serverRequest/resolved': {
        const r = this.s.requests.get(p.requestId);
        if (r) { this.s.requests.delete(p.requestId); if (!r.answeredHere) this.s.resolved = [{ threadId: r.params?.threadId, verdict: '다른 곳에서 처리됨', at: Date.now() }, ...this.s.resolved].slice(0, 20); }
        break;
      }
      default: break;
    }
    this.emit();
  }

  // ── actions ──
  mark(reqId, verdict) {
    const r = this.s.requests.get(reqId);
    if (!r) return;
    r.answeredHere = true;
    this.s.resolved = [{ threadId: r.params?.threadId, verdict, at: Date.now() }, ...this.s.resolved].slice(0, 20);
    this.s.requests.delete(reqId);
    this.emit();
  }
  respondApproval(reqId, decision) {
    this.c.respond(reqId, { decision });
    this.mark(reqId, { accept: '승인함', acceptForSession: '세션 동안 허용', decline: '거절함', cancel: '취소함' }[decision]);
  }
  async answer(reqId, answers, comment) {
    const r = this.s.requests.get(reqId);
    if (!r) return;
    this.c.respond(reqId, { answers, ...(comment ? { comment } : {}) });
    this.mark(reqId, '답변함');
  }
  async send(id, text) {
    let T = this.T(id);
    const input = [{ type: 'text', text }];
    if (!T.subscribed) T = await this.resume(id);
    const cur = currentTurn(T);
    if (cur && T.status?.type === 'active') return this.guard(this.c.request('turn/steer', { threadId: id, expectedTurnId: cur.id, input }), '끼어들기 실패');
    return this.guard(this.c.request('turn/start', { threadId: id, input }), '메시지를 보내지 못했습니다');
  }
  upload(file) { return this.guard(this.c.backend.upload(file), '이미지를 올리지 못했습니다'); }
  async interrupt(id) {
    const cur = currentTurn(this.T(id));
    if (cur) await this.guard(this.c.request('turn/interrupt', { threadId: id, turnId: cur.id }), '중단 실패');
  }
  async startThread(cwd, text, settings = {}) {
    const r = await this.guard(this.c.request('thread/start', { cwd }), '세션을 만들지 못했습니다');
    const T = this.merge({ ...r.thread, subscribed: true, settings: { model: modelRef(r.model, r.modelProvider), effort: r.reasoningEffort } });
    this.emit();
    // Chosen model and effort go through thread/settings/update like the composer's picker (thread/start takes no effort),
    // before the first message so its turn already runs with them. A failure is toasted and the session still opens.
    const patch = Object.fromEntries(Object.entries(settings).filter(([, v]) => v));
    if (Object.keys(patch).length) await this.setSettings(T.id, patch).catch(() => {});
    if (text) await this.send(T.id, text);
    return T.id;
  }
  async rename(id, name) { await this.guard(this.c.request('thread/name/set', { threadId: id, name }), '이름을 바꾸지 못했습니다'); this.T(id).name = name; this.emit(); }
  async fork(id) { const r = await this.guard(this.c.request('thread/fork', { threadId: id }), '복제 실패'); this.merge({ ...r.thread, subscribed: true }); this.emit(); return r.thread.id; }
  async archive(id) { await this.guard(this.c.request('thread/archive', { threadId: id }), '보관 실패'); Object.assign(this.T(id), { archived: true, subscribed: false }); this.emit(); }
  async unarchive(id) { await this.guard(this.c.request('thread/unarchive', { threadId: id }), '보관 해제 실패'); this.T(id).archived = false; this.emit(); }
  async unsubscribe(id) {
    await this.guard(this.c.request('thread/unsubscribe', { threadId: id }), '구독 해제 실패');
    this.T(id).subscribed = false;
    for (const r of this.reqsFor(id)) this.s.requests.delete(r.id);
    this.emit();
  }
  async remove(id) { await this.guard(this.c.request('thread/delete', { threadId: id }), '삭제 실패'); this.s.threads.delete(id); this.emit(); }
  async compact(id) { await this.guard(this.c.request('thread/compact/start', { threadId: id }), '압축 실패'); }
  async setSettings(id, patch) {
    await this.guard(this.c.request('thread/settings/update', { threadId: id, ...patch }), '설정을 바꾸지 못했습니다');
    const T = this.T(id); T.settings = { ...T.settings, ...patch }; this.emit();
  }
  async goalSet(id, patch) { const r = await this.guard(this.c.request('thread/goal/set', { threadId: id, ...patch }), '목표 저장 실패'); this.T(id).goal = r.goal; this.emit(); }
  async goalClear(id) { await this.guard(this.c.request('thread/goal/clear', { threadId: id }), '목표 삭제 실패'); this.T(id).goal = null; this.emit(); }
  async restoreTodos(id) {
    const T = this.T(id);
    const items = await this.guard(this.c.backend.restoreTodos(id), '세션 파일에서 복원하지 못했습니다');
    if (items?.length) { T.restored = items; T.turns = [...T.turns, { id: `restored-${id}`, status: 'completed', restored: true, items }]; this.toast('세션 파일에서 todo를 복원했습니다', 'info'); }
    else this.toast('복원할 todo가 없습니다', 'info');
    this.emit();
  }
}
