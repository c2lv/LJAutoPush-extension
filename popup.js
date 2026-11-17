const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;
const SITE = 'https://localjudge.com/';

let tab = null;
let onSite = false;
let contentReady = false;
let liveRunning = false;

const checks = () => [...document.querySelectorAll('[data-result]')];
const vchecks = () => [...document.querySelectorAll('[data-vresult]')];
function vOptions() {
  return {
    results: vchecks().filter((c) => c.checked).map((c) => c.dataset.vresult),
    problem: $('v-problem').value.trim().toUpperCase(),
  };
}

const show = (el, visible) => { el.hidden = !visible; };

// 'upload'(GitHub·업로드) 또는 'verify'(검증) 중 보이는 쪽
let currentTab = 'upload';
const tabs = () => [...document.querySelectorAll('[data-tab]')];
const kindOf = (st) => (st.kind === 'verify' ? 'verify' : 'upload');

async function render() {
  const s = await store.get(['token', 'repo', 'device', 'status', 'authError']);
  const nick = $('nick').value.trim();

  show($('auth-off'), !s.token && !s.device);
  show($('auth-pending'), !s.token && !!s.device);
  show($('auth-on'), !!s.token);
  if (s.device) $('code').textContent = s.device.user_code;
  if (s.token) {
    $('repo-link').textContent = s.repo ? `${s.repo.owner}/${s.repo.repo}` : '저장소 확인 중';
    if (s.repo) $('repo-link').href = s.repo.url;
    show($('repo-vis'), !!s.repo);
    if (s.repo) $('repo-vis').textContent = s.repo.private ? '비공개' : '공개';
  }
  show($('auth-error'), !!s.authError);
  $('auth-error').textContent = s.authError || '';

  const notes = [];
  if (!onSite) notes.push('로컬 저지 탭에서 실행해야 합니다.');
  else if (!contentReady) notes.push('이 탭을 새로고침한 뒤 다시 열어 주세요.');
  if (!nick) notes.push('로컬 저지 닉네임을 입력해 주세요.');
  const note = notes.join('\n');
  show($('site-note'), !!note);
  $('site-note').textContent = note;
  $('open-site').disabled = !nick;

  const st = s.status;
  const busy = !!st && st.running && (st.kind === 'verify' ? Date.now() - (st.heartbeat || 0) < 20000 : liveRunning);
  const ready = !!s.token && !!nick && contentReady && !busy;
  $('run-all').disabled = !ready;
  $('run-one').disabled = !ready;
  const vo = vOptions();
  $('run-verify').disabled = busy || !vo.results.length;

  for (const b of tabs()) b.setAttribute('aria-selected', String(b.dataset.tab === currentTab));
  show($('pane-upload'), currentTab === 'upload');
  show($('pane-verify'), currentTab === 'verify');

  const mine = !!st && kindOf(st) === currentTab;
  show($('progress'), mine);
  if (mine) {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    $('bar-fill').style.width = `${st.running || st.total ? pct : 0}%`;
    // 끝난 뒤 마지막 기록과 같은 메시지는 한 번만 보입니다.
    const repeated = !busy && st.log[st.log.length - 1] === st.msg;
    $('msg').textContent = repeated ? '' : st.total ? `${st.done}/${st.total} · ${st.msg}` : st.msg;
    $('log').textContent = st.log.join('\n');
    $('log').scrollTop = $('log').scrollHeight;
    show($('stop'), busy);
    show($('clear'), !busy);
  }
}

async function startRun(payload) {
  const nick = $('nick').value.trim();
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'run', nick, ...payload });
  if (!r.ok) {
    await store.set({ authError: r.error });
    return;
  }
  liveRunning = true;
  render();
}

async function init() {
  const s = await store.get(['nick', 'filters', 'vmax', 'vopts', 'tab', 'status']);
  currentTab = s.tab === 'verify' ? 'verify' : 'upload';
  // 실행 중인 작업이 있으면 그 쪽을 먼저 보여 줍니다.
  if (s.status && s.status.running) currentTab = kindOf(s.status);
  $('nick').value = s.nick || '';
  if (s.vmax) $('v-max').value = Math.min(20, s.vmax);
  if (s.vopts) {
    for (const c of vchecks()) c.checked = (s.vopts.results || ['ok']).includes(c.dataset.vresult);
    $('v-problem').value = s.vopts.problem || '';
  }
  // 0.2.0 개발판이 남긴 검증 기록과 조회 시각은 더 쓰지 않습니다.
  store.remove(['verified', 'verifiedSubs', 'vexcluded', 'vloads', 'vblockUntil']);
  if (s.filters) for (const c of checks()) c.checked = s.filters.includes(c.dataset.result);

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  onSite = !!(tab && tab.url && tab.url.startsWith(SITE));
  if (onSite) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
      contentReady = true;
      liveRunning = r.running;
      // 닉네임 칸이 비어 있으면 로그인한 계정으로 채웁니다. 직접 입력한 값은 바꾸지 않습니다.
      if (r.me && !$('nick').value.trim()) {
        $('nick').value = r.me;
        store.set({ nick: r.me });
      }
    } catch {}
  }
  if ((await store.get('device')).device) chrome.runtime.sendMessage({ type: 'authResume' });
  render();
}

$('help-btn').addEventListener('click', () => {
  const open = $('help').hidden;
  $('help').hidden = !open;
  $('help-btn').setAttribute('aria-expanded', String(open));
});

for (const b of tabs()) {
  b.addEventListener('click', () => {
    currentTab = b.dataset.tab;
    store.set({ tab: currentTab });
    render();
  });
}

$('clear').addEventListener('click', () => store.remove('status'));

$('v-max').addEventListener('change', () => store.set({ vmax: Number($('v-max').value) || 1 }));
for (const el of [...vchecks(), $('v-problem')]) {
  el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {
    store.set({ vopts: vOptions() });
    render();
  });
}

$('nick').addEventListener('input', () => {
  store.set({ nick: $('nick').value.trim() });
  render();
});

for (const c of checks()) {
  c.addEventListener('change', () => {
    store.set({ filters: checks().filter((x) => x.checked).map((x) => x.dataset.result) });
  });
}

$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'authStart' });
  $('connect').disabled = false;
  if (!r.ok) await store.set({ authError: r.error });
});

$('open-github').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('code').textContent);
  chrome.tabs.create({ url: 'https://github.com/login/device' });
});

$('cancel-auth').addEventListener('click', () => store.remove(['device', 'authError']));
$('logout').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'logout' }));

$('open-site').addEventListener('click', () => {
  const nick = $('nick').value.trim();
  chrome.tabs.create({ url: `${SITE}submissions?user=${encodeURIComponent(nick)}` });
});

$('run-all').addEventListener('click', () => {
  const results = checks().filter((c) => c.checked).map((c) => c.dataset.result);
  if (!results.length) {
    store.set({ status: { running: false, done: 0, total: 0, msg: '결과를 하나 이상 체크하세요.', log: [] } });
    return;
  }
  startRun({ mode: 'all', results });
});

$('run-one').addEventListener('click', () => {
  const id = Number($('one-id').value);
  if (!Number.isInteger(id) || id < 1) {
    $('one-id').focus();
    return;
  }
  startRun({ mode: 'one', id });
});

$('run-verify').addEventListener('click', async () => {
  const max = Math.min(20, Math.max(1, Number($('v-max').value) || 1));
  await store.set({
    vjob: { max, ...vOptions() },
    vstop: false,
    vmax: max,
    status: { kind: 'verify', running: true, done: 0, total: 0, msg: '검증 탭 여는 중', log: [], heartbeat: Date.now() },
  });
  chrome.tabs.create({ url: `${SITE}verify#ljap`, active: true });
});

$('stop').addEventListener('click', async () => {
  const { status } = await store.get('status');
  if (status && status.kind === 'verify') store.set({ vstop: true });
  else chrome.tabs.sendMessage(tab.id, { type: 'stop' });
});

chrome.storage.onChanged.addListener(render);
init();
