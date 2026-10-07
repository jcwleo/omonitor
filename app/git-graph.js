// mc-git-graph: the Git tab of a session's side panel. The header shows the folder's branch, its upstream and uncommitted
// changes; below are the latest commits of every branch, remote branch and tag, drawn in lanes like `git log --graph`.
// A tap on a commit shows its details. It reads GET /api/git every 10s while the page is visible.
const base = new URL('../', import.meta.url);
const url = (path) => new URL(path, base);
const POLL_MS = 10_000;
const ROW = 28, LANE = 12, PAD = 7, DOT = 3.5;
const COLORS = ['var(--acc)', 'var(--add-fg)', 'var(--warn)', 'oklch(0.7 0.13 300)', 'var(--del-fg)', 'oklch(0.72 0.1 200)'];
const color = (i) => COLORS[i % COLORS.length];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}일 전`;
  const d = new Date(ms);
  return d.getFullYear() === new Date().getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
};

// Each lane waits for one commit. A commit takes the leftmost lane waiting for it (the other lanes waiting for it end
// there: its children on other branches), or a free lane if it is a branch tip. Its first parent continues in its lane
// unless another lane already waits for that parent, and each further parent (a merge) gets its own lane. Lanes never
// move sideways, so a lane passing a row is a straight line.
export function layoutGraph(commits) {
  const lanes = [];
  let width = 1;
  const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  const rows = commits.map((c) => {
    const before = lanes.slice();
    const into = before.flatMap((h, i) => (h === c.hash ? [i] : []));
    const col = into.length ? into[0] : free();
    for (const i of into) lanes[i] = null;
    lanes[col] = null;
    const out = c.parents.map((p, k) => {
      const j = lanes.indexOf(p);
      if (j >= 0) return j;
      const f = k === 0 ? col : free();
      lanes[f] = p;
      return f;
    });
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    width = Math.max(width, before.length, lanes.length, col + 1);
    return { col, before, out };
  });
  return { rows, width };
}

function rowSvg(c, r, w, isHead) {
  const x = (i) => PAD + i * LANE, mid = ROW / 2;
  const curve = (x1, y1, x2, y2) => (x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
  const paths = [];
  r.before.forEach((h, i) => {
    if (h == null) return;
    paths.push([h === c.hash ? curve(x(i), 0, x(r.col), mid) : `M${x(i)} 0V${ROW}`, i]);
  });
  r.out.forEach((j) => paths.push([curve(x(r.col), mid, x(j), ROW), j]));
  const cx = x(r.col), fill = color(r.col);
  const dot = c.parents.length > 1
    ? `<circle cx="${cx}" cy="${mid}" r="${DOT}" style="fill:var(--bg);stroke:${fill};stroke-width:1.6"/>`
    : `<circle cx="${cx}" cy="${mid}" r="${DOT}" style="fill:${fill}"/>`;
  const ring = isHead ? `<circle cx="${cx}" cy="${mid}" r="${DOT + 2.6}" style="fill:none;stroke:${fill};stroke-width:1.4"/>` : '';
  return `<svg width="${w}" height="${ROW}" viewBox="0 0 ${w} ${ROW}" aria-hidden="true">${paths.map(([d, i]) => `<path d="${d}" style="stroke:${color(i)}"/>`).join('')}${ring}${dot}</svg>`;
}

const refPill = (ref) => `<span class="ref ${ref.current ? 'current' : ref.kind}" title="${esc(ref.name)}">${esc(ref.name)}</span>`;

// The key changes on every server start, so a 401 fetches it again once.
let key = null;
async function sessionKey() {
  const r = await fetch(url('api/config'), { cache: 'no-store' });
  if (!r.ok) throw new Error('서버 연결을 확인하세요');
  return (key = (await r.json()).key);
}
async function loadGit(cwd) {
  for (let retried = false; ; retried = true) {
    const r = await fetch(url(`api/git?cwd=${encodeURIComponent(cwd)}`), { cache: 'no-store', headers: { 'x-mc-key': key ?? await sessionKey() } });
    if (r.status === 401 && !retried) { key = null; continue; }
    if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
    return r.json();
  }
}

const CSS = `
:host{display:block;height:100%;min-width:0;min-height:0;color:var(--fg)}
*{box-sizing:border-box}
[hidden]{display:none!important}
section{display:flex;flex-direction:column;gap:6px;height:100%;min-width:0;min-height:0}
header{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-width:0}
.pill{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;padding:2px 8px;border-radius:999px}
.branch{font-family:var(--mono);background:var(--acc-tint);color:var(--acc-fg)}
.branch.detached{background:var(--warn-tint);color:color-mix(in oklab,var(--warn) 70%,var(--fg))}
.changes{background:color-mix(in oklab,var(--warn) 15%,transparent);color:color-mix(in oklab,var(--warn) 70%,var(--fg))}
.clean{font-size:12px;color:var(--fg3)}
.sync{display:flex;align-items:center;gap:5px;min-width:0;font:11.5px var(--mono);color:var(--fg3)}
.sync span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sync .ahead{color:var(--acc-fg)}.sync .behind{color:color-mix(in oklab,var(--warn) 70%,var(--fg))}
.refresh{all:unset;cursor:pointer;margin-left:auto;width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:var(--r-sm,6px);color:var(--fg3)}
.refresh:hover{color:var(--fg);background:var(--hover)}
.refresh:focus-visible,.row:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}
.refresh[aria-busy=true] svg{opacity:.45}
.root{flex:none;font:11px var(--mono);color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.detail{flex:none;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:var(--r,10px);background:var(--tint);animation:drop var(--dur,180ms) var(--ease-out,ease-out)}
.detail .s{font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.detail .h{font:11.5px var(--mono);color:var(--fg2);word-break:break-all;user-select:all}
.detail .a{font-size:12px;color:var(--fg3)}
.detail .refs{flex-wrap:wrap;max-width:none}
.list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;margin:0 -4px}
.row{all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;gap:6px;width:100%;height:${ROW}px;padding-right:6px;border-radius:var(--r-sm,6px)}
.row:hover{background:var(--hover)}
.row[aria-pressed=true]{background:var(--sel)}
.row svg{flex:none;fill:none;stroke-width:1.6;stroke-linecap:round}
.refs{flex:0 1 auto;max-width:55%;min-width:0;display:flex;gap:3px;overflow:hidden}
.refs:empty{display:none}
.ref{flex:0 1 auto;min-width:2.5em;max-width:11em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px var(--mono);padding:1px 6px;border-radius:999px}
.ref.branch{background:var(--acc-tint);color:var(--acc-fg)}
.ref.current{background:var(--acc);color:var(--on-acc)}
.ref.remote{background:var(--sel);color:var(--fg2)}
.ref.tag{background:color-mix(in oklab,var(--warn) 15%,transparent);color:color-mix(in oklab,var(--warn) 70%,var(--fg))}
.ref.head{background:var(--warn-tint);color:color-mix(in oklab,var(--warn) 70%,var(--fg))}
.subj{flex:1 1 0;min-width:3em;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.when{flex:none;font-size:11.5px;color:var(--fg3)}
.msg{font-size:13px;line-height:1.5;color:var(--fg3);padding:6px 0}
.error{flex:none;border-radius:var(--r,10px);background:var(--err-tint);padding:8px 10px;font-size:12.5px;color:var(--err-fg);word-break:break-word}
.more{font-size:12px;color:var(--fg3);padding:6px 4px}
@keyframes drop{from{opacity:0;translate:0 -4px}}
@media (prefers-reduced-motion:reduce){@keyframes drop{from{opacity:0}}}
`;

class McGitGraph extends HTMLElement {
  static observedAttributes = ['cwd'];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.gen = 0;
    this.shadowRoot.innerHTML = `<style>${CSS}</style>
      <section>
        <header hidden><span class="pill branch"></span><span class="sync"></span><span class="status"></span>
          <button type="button" class="refresh" aria-label="새로 고침" title="새로 고침"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button></header>
        <div class="root" hidden></div>
        <div class="error" role="alert" hidden></div>
        <div class="detail" hidden></div>
        <div class="list" role="list" aria-label="커밋 그래프"></div>
        <div class="msg"></div>
      </section>`;
    this.el = (s) => this.shadowRoot.querySelector(s);
    this.shadowRoot.addEventListener('click', (e) => {
      if (e.target.closest('.refresh')) { this.refresh(); return; }
      const row = e.target.closest('.row');
      if (!row) return;
      this.selected = this.selected === row.dataset.hash ? null : row.dataset.hash;
      for (const r of this.shadowRoot.querySelectorAll('.row')) r.setAttribute('aria-pressed', String(r.dataset.hash === this.selected));
      this.renderDetail(true);
    });
  }
  connectedCallback() {
    this.reset();
    this.timer = setInterval(() => { if (document.visibilityState === 'visible') this.refresh(); }, POLL_MS);
  }
  disconnectedCallback() { clearInterval(this.timer); this.gen++; }
  attributeChangedCallback(_name, oldValue, newValue) { if (oldValue !== newValue && this.isConnected) this.reset(); }
  reset() {
    this.gen++;
    this.busy = null;
    this.data = null;
    this.text = '';
    this.selected = null;
    this.el('header').hidden = true;
    this.el('.root').hidden = true;
    this.el('.detail').hidden = true;
    this.el('.error').hidden = true;
    this.el('.list').replaceChildren();
    this.el('.msg').textContent = '불러오는 중…';
    this.refresh();
  }
  async refresh() {
    if (this.busy === this.gen) return;
    const gen = this.busy = this.gen;
    this.el('.refresh').setAttribute('aria-busy', 'true');
    try {
      const data = await loadGit(this.getAttribute('cwd') || '');
      if (gen !== this.gen) return;
      this.el('.error').hidden = true;
      // Unchanged data is drawn again only once a minute, for the relative times; a redraw would drop a hover or focus.
      const text = JSON.stringify(data);
      if (text !== this.text || Date.now() - this.drawnAt > 60_000) { this.text = text; this.data = data; this.render(); }
    } catch (error) {
      if (gen !== this.gen) return;
      this.el('.error').textContent = `Git 정보를 읽지 못했습니다: ${error?.message || error}`;
      this.el('.error').hidden = false;
      if (!this.data) this.el('.msg').textContent = '';
    } finally {
      if (this.busy === gen) { this.busy = null; this.el('.refresh').setAttribute('aria-busy', 'false'); }
    }
  }
  render() {
    const d = this.data;
    this.drawnAt = Date.now();
    const focused = this.shadowRoot.activeElement?.dataset?.hash;
    this.el('header').hidden = !d.repo;
    this.el('.root').hidden = !d.repo;
    if (!d.repo) {
      this.el('.list').replaceChildren();
      this.el('.detail').hidden = true;
      this.el('.msg').textContent = d.reason;
      return;
    }
    const branch = this.el('.branch');
    branch.classList.toggle('detached', !d.branch);
    branch.textContent = d.branch || `HEAD 분리됨${d.oid ? ` · ${d.oid.slice(0, 7)}` : ''}`;
    branch.title = branch.textContent;
    this.el('.sync').innerHTML = d.upstream
      ? `${d.ahead ? `<span class="ahead" title="올리지 않은 커밋 ${d.ahead}개">↑${d.ahead}</span>` : ''}${d.behind ? `<span class="behind" title="받지 않은 커밋 ${d.behind}개">↓${d.behind}</span>` : ''}<span title="추적하는 원격 브랜치">${esc(d.upstream)}</span>`
      : '';
    const status = this.el('.status');
    status.className = d.changes ? 'status pill changes' : 'status clean';
    status.textContent = d.changes ? `변경 ${d.changes}개` : '변경 없음';
    status.title = d.changes ? '커밋하지 않은 변경 파일 수' : '';
    this.el('.root').textContent = d.root;
    this.el('.root').title = d.root;
    const { rows, width } = layoutGraph(d.commits);
    const w = PAD * 2 + (width - 1) * LANE;
    if (!d.commits.some((c) => c.hash === this.selected)) this.selected = null;
    this.el('.list').innerHTML = d.commits.map((c, i) => {
      const title = `${c.hash.slice(0, 7)} · ${c.author} · ${new Date(c.time).toLocaleString('ko-KR')}\n${c.subject}`;
      return `<button type="button" class="row" role="listitem" data-hash="${c.hash}" aria-pressed="${c.hash === this.selected}" title="${esc(title)}">`
        + `${rowSvg(c, rows[i], w, c.hash === d.oid)}<span class="refs">${c.refs.map(refPill).join('')}</span>`
        + `<span class="subj">${esc(c.subject)}</span><span class="when">${ago(c.time)}</span></button>`;
    }).join('') + (d.truncated ? `<div class="more">최근 커밋 ${d.commits.length}개까지 보여 줍니다</div>` : '');
    this.el('.msg').textContent = d.commits.length ? '' : '아직 커밋이 없습니다.';
    if (focused) this.shadowRoot.querySelector(`.row[data-hash="${focused}"]`)?.focus();
    this.renderDetail(false);
  }
  renderDetail(fresh) {
    const box = this.el('.detail');
    const c = this.data?.commits?.find((x) => x.hash === this.selected);
    box.hidden = !c;
    if (!c) return;
    if (fresh) { box.style.animation = 'none'; void box.offsetWidth; box.style.animation = ''; }
    const parents = c.parents.length > 1 ? ` · 병합 (부모 ${c.parents.length}개)` : c.parents.length ? '' : ' · 첫 커밋';
    box.innerHTML = `<div class="s">${esc(c.subject)}</div>${c.refs.length ? `<div class="refs">${c.refs.map(refPill).join('')}</div>` : ''}`
      + `<div class="h">${c.hash}</div><div class="a">${esc(c.author)} · ${esc(new Date(c.time).toLocaleString('ko-KR'))}${parents}</div>`;
  }
}

export function defineGitGraph() {
  if (!customElements.get('mc-git-graph')) customElements.define('mc-git-graph', McGitGraph);
}
