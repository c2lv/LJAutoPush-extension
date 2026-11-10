importScripts('config.js');

const API = 'https://api.github.com';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const store = chrome.storage.local;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64(text) {
  let bin = '';
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

async function gh(method, path, body) {
  const { token } = await store.get('token');
  if (!token) return { ok: false, status: 401, data: { message: 'GitHub 연동이 필요합니다.' } };
  const res = await fetch(API + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data, retryAfter: Number(res.headers.get('retry-after')) || 0 };
}

async function githubForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  return res.json();
}

async function authStart() {
  if (!LJ_CONFIG.CLIENT_ID) throw new Error('config.js에 CLIENT_ID가 비어 있습니다.');
  const d = await githubForm('https://github.com/login/device/code', {
    client_id: LJ_CONFIG.CLIENT_ID,
    scope: 'repo',
  });
  if (!d.device_code) throw new Error(d.error_description || d.error || '기기 코드를 받지 못했습니다.');
  await store.remove('authError');
  await store.set({
    device: {
      device_code: d.device_code,
      user_code: d.user_code,
      interval: d.interval || 5,
      expiresAt: Date.now() + d.expires_in * 1000,
    },
  });
  pollDevice();
}

let polling = false;
async function pollDevice() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const { device } = await store.get('device');
      if (!device) return;
      if (Date.now() > device.expiresAt) {
        await store.remove('device');
        await store.set({ authError: '코드가 만료되었습니다. 다시 연동하세요.' });
        return;
      }
      await sleep(device.interval * 1000);
      const r = await githubForm('https://github.com/login/oauth/access_token', {
        client_id: LJ_CONFIG.CLIENT_ID,
        device_code: device.device_code,
        grant_type: DEVICE_GRANT,
      });
      if (r.access_token) {
        await store.set({ token: r.access_token });
        await store.remove('device');
        try {
          await ensureRepo();
        } catch (e) {
          await store.set({ authError: e.message });
        }
        return;
      }
      if (r.error === 'authorization_pending') continue;
      if (r.error === 'slow_down') {
        await store.set({ device: { ...device, interval: (r.interval || device.interval + 5) } });
        continue;
      }
      await store.remove('device');
      await store.set({ authError: r.error_description || r.error || '연동에 실패했습니다.' });
      return;
    }
  } finally {
    polling = false;
  }
}

async function ensureRepo() {
  const user = await gh('GET', '/user');
  if (!user.ok) throw new Error(`GitHub 사용자 확인 실패 (${user.status}): ${user.data?.message || ''}`);
  const owner = user.data.login;
  const base = `/repos/${owner}/${LJ_CONFIG.REPO}`;
  let repo = await gh('GET', base);
  if (repo.status === 404) {
    const created = await gh('POST', '/user/repos', {
      name: LJ_CONFIG.REPO,
      private: true,
      description: '로컬 저지(localjudge.com) 제출 기록 - LJAutoPush',
      auto_init: false,
    });
    if (!created.ok) throw new Error(`저장소 생성 실패 (${created.status}): ${created.data?.message || ''}`);
    const readme = `# ${LJ_CONFIG.REPO}\n\n[로컬 저지](https://localjudge.com/)에 낸 제출을 LJAutoPush가 올리는 저장소입니다.\n`;
    const put = await gh('PUT', `${base}/contents/README.md`, {
      message: 'LJAutoPush 저장소 생성',
      content: b64(readme),
    });
    if (!put.ok) throw new Error(`README 생성 실패 (${put.status}): ${put.data?.message || ''}`);
    repo = await gh('GET', base);
  }
  if (!repo.ok) throw new Error(`저장소 확인 실패 (${repo.status}): ${repo.data?.message || ''}`);
  const info = {
    owner,
    repo: LJ_CONFIG.REPO,
    branch: repo.data.default_branch,
    private: repo.data.private,
    url: repo.data.html_url,
  };
  await store.set({ repo: info });
  return info;
}

const handlers = {
  gh: (m) => gh(m.method, m.path, m.body),
  authStart: async () => {
    await authStart();
    return { ok: true };
  },
  authResume: async () => {
    pollDevice();
    return { ok: true };
  },
  ensureRepo: async () => ({ ok: true, repo: await ensureRepo() }),
  logout: async () => {
    await store.remove(['token', 'repo', 'device', 'authError']);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
