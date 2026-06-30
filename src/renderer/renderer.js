'use strict';

/* globals Terminal, FitAddon, WebLinksAddon */

const bridge = window.api;
let profiles = [];
let currentTailnet = '';
let tmuxOn = false;
let activeSession = null;
let mode = 'local'; // 'local' | 'remote'
let hosts = [];
let currentHost = null;

// tmux session names cannot contain '.' or ':'.
function sessionFor(tailnet) {
  return String(tailnet || 'main').replace(/[.:\s]/g, '-') || 'main';
}
function size() {
  return { cols: term.cols, rows: term.rows };
}

// ---- Terminal ----
const term = new Terminal({
  fontFamily: 'SF Mono, Menlo, Monaco, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: {
    background: '#16181d',
    foreground: '#e6e8ec',
    cursor: '#4fd6a3',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
// Detect URLs (even wrapped across rows) and open them in the real browser on
// click — long OAuth/login URLs are painful to select, so just click them.
term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => bridge.openExternal(uri)));
term.open(document.getElementById('terminal'));
fit.fit();

// When a TUI (Claude Code/tmux mouse mode) grabs the mouse, hold ⌥ and drag
// to force an xterm text selection so ⌘C can copy it.
term.options.macOptionClickForcesSelection = true;

// ⌘C / ⌘V / ⌘A routed from the native menu (xterm selection isn't DOM-based).
bridge.onMenu(async (action) => {
  if (action === 'copy') {
    if (term.hasSelection()) await bridge.clipWrite(term.getSelection());
  } else if (action === 'paste') {
    const text = await bridge.clipRead();
    if (text) bridge.termInput(text);
    term.focus();
  } else if (action === 'selectall') {
    term.selectAll();
  }
});

// Always route keyboard to the terminal: focus on any click in the pane,
// and when the window regains focus. (Switching tailnets/hosts is async and
// can otherwise leave focus off the xterm textarea, so typing goes nowhere.)
const termEl = document.getElementById('terminal');
termEl.addEventListener('mousedown', () => setTimeout(() => term.focus(), 0));
window.addEventListener('focus', () => term.focus());

// iTerm-style split/pane shortcuts. We're always attached to tmux (local or
// remote), so send tmux's prefix (C-b) + key — drives whichever tmux the
// terminal is on. Assumes the default C-b prefix.
const TMUX_PREFIX = '\x02'; // Ctrl-b
function tmuxKey(seq) {
  bridge.termInput(TMUX_PREFIX + seq);
  term.focus();
  if (mode === 'local') setTimeout(renderSessions, 60);
}
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey) return true;
  const k = e.key;
  if (k === 'd' || k === 'D') return tmuxKey(e.shiftKey ? '"' : '%'), e.preventDefault(), false; // split ⬌ / ⬍
  if (k === 't' || k === 'T') return tmuxKey('c'), e.preventDefault(), false; // new window (tab)
  if (k === 'w' || k === 'W') return tmuxKey('x'), e.preventDefault(), false; // close pane (asks y)
  if (k === ']') return tmuxKey('o'), e.preventDefault(), false; // next pane  ⌘]
  if (k === '[') return tmuxKey(';'), e.preventDefault(), false; // prev/last pane  ⌘[
  if (e.altKey && k === 'ArrowLeft') return tmuxKey('\x1b[D'), e.preventDefault(), false;
  if (e.altKey && k === 'ArrowRight') return tmuxKey('\x1b[C'), e.preventDefault(), false;
  if (e.altKey && k === 'ArrowUp') return tmuxKey('\x1b[A'), e.preventDefault(), false;
  if (e.altKey && k === 'ArrowDown') return tmuxKey('\x1b[B'), e.preventDefault(), false;
  if (k === '{') return tmuxKey('p'), e.preventDefault(), false; // prev window  ⌘⇧[
  if (k === '}') return tmuxKey('n'), e.preventDefault(), false; // next window  ⌘⇧]
  if (k >= '1' && k <= '9') return tmuxKey(k), e.preventDefault(), false; // select window N
  return true;
});

term.onData((d) => bridge.termInput(d));
bridge.onTermData((d) => term.write(d));
bridge.onTermExit(() => {
  if (mode === 'remote') {
    term.write(
      '\r\n\x1b[33m[원격 연결 끊김 — 원격 tmux 세션과 작업(Claude 등)은 그대로 실행 중입니다.\r\n' +
        ' 다시 연결하려면 왼쪽에서 그 호스트를 클릭하세요.]\x1b[0m\r\n'
    );
  } else {
    term.write('\r\n\x1b[31m[셸 종료됨]\x1b[0m\r\n');
  }
});

function doFit() {
  try {
    fit.fit();
    bridge.termResize({ cols: term.cols, rows: term.rows });
  } catch (_) {}
}
window.addEventListener('resize', doFit);
new ResizeObserver(doFit).observe(document.getElementById('terminal'));

// ---- Toast ----
let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---- Profiles ----
function renderProfiles() {
  const ul = document.getElementById('profiles');
  ul.innerHTML = '';
  for (const p of profiles) {
    const li = document.createElement('li');
    li.className = 'profile' + (p.current ? ' current' : '');
    li.dataset.id = p.id;
    li.innerHTML = `
      <div class="tailnet"><span class="dot"></span>${escapeHtml(p.tailnet)}</div>
      <div class="meta">${escapeHtml(p.account)} · ${p.id}</div>`;
    li.addEventListener('click', () => switchTo(p));
    ul.appendChild(li);
  }
  const cur = profiles.find((p) => p.current);
  currentTailnet = cur ? cur.tailnet : '';
  setHeaderLabel();
}

async function switchTo(p) {
  if (p.current) return;
  const li = document.querySelector(`.profile[data-id="${p.id}"]`);
  if (li) li.classList.add('switching');
  toast(`전환 중: ${p.tailnet} …`);
  try {
    const { profiles: next, status } = await bridge.switchTo(p.id);
    profiles = next;
    renderProfiles();
    renderStatus(status);
    // Per-tailnet LOCAL tmux workspace: only re-point the embedded terminal
    // when we're in local mode. In remote mode the terminal stays on the
    // remote host (and its work keeps running regardless of this switch).
    if (tmuxOn && mode === 'local') await attachSession(sessionFor(p.tailnet));
    toast(`전환 완료: ${p.tailnet}`);
  } catch (err) {
    toast(`전환 실패: ${err.message || err}`);
    if (li) li.classList.remove('switching');
  }
}

function renderStatus(s) {
  const el = document.getElementById('status');
  if (!s) return;
  const ip = (s.ips && s.ips[0]) || '—';
  el.textContent = `상태: ${s.backendState}\n${s.dnsName || '—'}\n${ip}`;
}

async function refresh() {
  try {
    profiles = await bridge.listProfiles();
    renderProfiles();
    renderStatus(await bridge.status());
  } catch (err) {
    toast(`목록 로드 실패: ${err.message || err}`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---- tmux ----
async function attachSession(session) {
  term.clear();
  const { current } = await bridge.tmuxAttach(session, size());
  activeSession = current;
  // tmux redraws on attach, but nudge a resize so it matches the pane exactly.
  setTimeout(doFit, 30);
  term.focus();
  renderSessions();
}

async function renderSessions() {
  const bar = document.getElementById('tmux-bar');
  bar.style.display = 'flex';
  const tabs = bar.querySelector('#tmux-tabs');
  tabs.innerHTML = '';
  // Remote mode drives the remote tmux; the local session list doesn't apply.
  if (mode === 'remote') {
    const span = document.createElement('span');
    span.className = 'tmux-empty';
    span.textContent = `🖥 ${currentHost ? currentHost.label : 'remote'} — ⌘D 분할`;
    tabs.appendChild(span);
    return;
  }
  if (!tmuxOn) {
    bar.style.display = 'none';
    return;
  }
  const sessions = await bridge.tmuxList();
  for (const s of sessions) {
    const el = document.createElement('button');
    el.className = 'tmux-tab' + (s.name === activeSession ? ' active' : '');
    el.textContent = `${s.name} · ${s.windows}창`;
    el.title = '클릭: 이 세션에 붙기';
    el.addEventListener('click', () => attachSession(s.name));
    tabs.appendChild(el);
  }
  if (!sessions.length) {
    const span = document.createElement('span');
    span.className = 'tmux-empty';
    span.textContent = '세션 없음';
    tabs.appendChild(span);
  }
}

// ---- Remote hosts ----
function setHeaderLabel() {
  const el = document.getElementById('current-label');
  if (mode === 'remote' && currentHost) el.textContent = `🖥 ${currentHost.label}`;
  else el.textContent = currentTailnet ? `● ${currentTailnet}` : '—';
}

async function renderHosts() {
  hosts = await bridge.hostsLoad();
  const ul = document.getElementById('hosts');
  ul.innerHTML = '';
  for (const h of hosts) {
    const li = document.createElement('li');
    li.className = 'profile host' + (currentHost && currentHost.id === h.id ? ' current' : '');
    li.dataset.id = h.id;
    const prof = profiles.find((p) => p.id === h.profileId);
    const who = (h.user ? `${h.user}@` : '') + h.target;
    const meta = [who, prof ? prof.tailnet : null, h.session || '마지막 세션'].filter(Boolean).join(' · ');
    li.innerHTML = `
      <div class="row">
        <div class="tailnet"><span class="dot"></span>${escapeHtml(h.label)}</div>
        <button class="del" title="삭제">×</button>
      </div>
      <div class="meta">${escapeHtml(meta)}</div>`;
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')) return;
      connectHost(h);
    });
    li.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      hosts = await bridge.hostsRemove(h.id);
      if (currentHost && currentHost.id === h.id) currentHost = null;
      renderHosts();
    });
    ul.appendChild(li);
  }
}

async function connectHost(h) {
  const li = document.querySelector(`.host[data-id="${h.id}"]`);
  if (li) li.classList.add('connecting');
  toast(`연결 중: ${h.label} …`);
  try {
    term.clear();
    const { profiles: next, status } = await bridge.hostConnect(h, size());
    if (next) profiles = next;
    if (status) renderStatus(status);
    renderProfiles();
    mode = 'remote';
    currentHost = h;
    setHeaderLabel();
    renderSessions();
    renderHosts();
    // After the (async) tailnet switch + reattach, focus can land off the
    // terminal — re-focus so keystrokes go to the remote session.
    setTimeout(() => { doFit(); term.focus(); }, 60);
    term.focus();
    toast(`연결됨: ${h.label}`);
  } catch (err) {
    toast(`연결 실패: ${err.message || err}`);
  } finally {
    if (li) li.classList.remove('connecting');
  }
}

async function goLocal() {
  mode = 'local';
  currentHost = null;
  term.clear();
  const session = tmuxOn ? sessionFor(currentTailnet) : null;
  const { current } = await bridge.tmuxAttach(session, size());
  activeSession = current;
  document.getElementById('tmux-bar').style.display = tmuxOn ? 'flex' : 'none';
  setHeaderLabel();
  renderSessions();
  renderHosts();
  setTimeout(() => { doFit(); term.focus(); }, 30);
  term.focus();
}

function populateProfileSelect() {
  const sel = document.getElementById('hf-profile');
  const keep = sel.value;
  sel.innerHTML = '<option value="">tailnet 자동 전환 안 함</option>';
  for (const p of profiles) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.tailnet;
    sel.appendChild(o);
  }
  sel.value = keep;
}

const hostForm = document.getElementById('host-form');
document.getElementById('add-host').addEventListener('click', () => {
  populateProfileSelect();
  hostForm.hidden = !hostForm.hidden;
});
document.getElementById('hf-cancel').addEventListener('click', () => {
  hostForm.hidden = true;
  hostForm.reset();
});
hostForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = (id) => document.getElementById(id).value.trim();
  const host = {
    label: v('hf-label'),
    target: v('hf-target'),
    user: v('hf-user'),
    session: v('hf-session'),
    profileId: v('hf-profile'),
  };
  if (!host.label || !host.target) return;
  hosts = await bridge.hostsUpsert(host);
  hostForm.hidden = true;
  hostForm.reset();
  renderHosts();
  toast(`호스트 저장: ${host.label}`);
});
document.getElementById('go-local').addEventListener('click', goLocal);

// ---- Toolbar ----
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('clear-term').addEventListener('click', () => term.clear());
document.getElementById('open-iterm').addEventListener('click', async () => {
  try {
    await bridge.openIterm(currentTailnet);
    toast(`iTerm2에서 열기: ${currentTailnet || 'tailscale'}`);
  } catch (err) {
    toast(`iTerm2 열기 실패: ${err.message || err}`);
  }
});
document.getElementById('tmux-new').addEventListener('click', () => tmuxKey('c'));
document.getElementById('tmux-split-h').addEventListener('click', () => tmuxKey('%')); // ⬌ 좌우
document.getElementById('tmux-split-v').addEventListener('click', () => tmuxKey('"')); // ⬍ 상하

// ---- Bootstrap ----
(async function init() {
  await refresh();
  const info = await bridge.tmuxInfo();
  tmuxOn = info.available;
  const session = tmuxOn ? sessionFor(currentTailnet) : null;
  bridge.termStart({ ...size(), session });
  activeSession = session;
  await renderSessions();
  await renderHosts();
  term.focus();
})();
