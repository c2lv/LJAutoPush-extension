const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;
const SITE = 'https://localjudge.com/';

let tab = null;
let onSite = false;
let contentReady = false;
let liveRunning = false;

const checks = () => [...document.querySelectorAll('[data-result]')];
const show = (el, visible) => { el.hidden = !visible; };

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

  let note = '';
  if (!onSite) note = '로컬 저지 탭에서 실행해야 합니다.';
  else if (!contentReady) note = '이 탭을 새로고침한 뒤 다시 열어 주세요.';
  show($('site-note'), !!note);
  $('site-note').textContent = note;
  show($('open-site'), !onSite);
  $('open-site').disabled = !nick;

  const st = s.status;
  const busy = liveRunning && !!st && st.running;
  const ready = !!s.token && !!nick && contentReady && !busy;
  $('run-all').disabled = !ready;
  $('run-one').disabled = !ready;

  show($('progress'), !!st);
  if (st) {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    $('bar-fill').style.width = `${st.running || st.total ? pct : 0}%`;
    $('msg').textContent = st.total ? `${st.done}/${st.total} · ${st.msg}` : st.msg;
    $('log').textContent = st.log.join('\n');
    $('log').scrollTop = $('log').scrollHeight;
    show($('stop'), busy);
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
  const s = await store.get(['nick', 'filters']);
  $('nick').value = s.nick || '';
  if (s.filters) for (const c of checks()) c.checked = s.filters.includes(c.dataset.result);

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  onSite = !!(tab && tab.url && tab.url.startsWith(SITE));
  if (onSite) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
      contentReady = true;
      liveRunning = r.running;
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

$('stop').addEventListener('click', () => chrome.tabs.sendMessage(tab.id, { type: 'stop' }));

chrome.storage.onChanged.addListener(render);
init();
