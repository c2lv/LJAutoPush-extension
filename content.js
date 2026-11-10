(() => {
  const ROOT = LJ_CONFIG.ROOT;
  const store = chrome.storage.local;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LJ_DELAY = 300; // 로컬 저지 요청 간격(ms)

  let running = false;
  let stopRequested = false;

  async function gh(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const r = await chrome.runtime.sendMessage({ type: 'gh', method, path, body });
      if (r && r.ok) return r.data;
      const message = (r && r.data && r.data.message) || (r && r.error) || '';
      const limited = r && (r.status === 403 || r.status === 429) && /rate limit/i.test(message);
      if (limited && attempt < 3) {
        const wait = Math.max(r.retryAfter || 0, 60);
        await report(`GitHub 요청 제한. ${wait}초 기다립니다.`);
        await sleep(wait * 1000);
        continue;
      }
      throw new Error(`GitHub ${method} 실패 (${r ? r.status : '응답 없음'}): ${message}`);
    }
  }

  async function fetchDoc(path) {
    const res = await fetch(location.origin + path, { credentials: 'include' });
    if (!res.ok) throw new Error(`${path} 요청 실패 (${res.status})`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  const status = { running: false, done: 0, total: 0, uploaded: 0, skipped: 0, failed: 0, msg: '', log: [] };
  async function report(msg, keep = false) {
    status.msg = msg;
    if (keep) status.log = [...status.log, msg].slice(-200);
    await store.set({ status: { ...status } });
  }

  const sanitize = (name) => name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
  const sameUser = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

  async function collectTargets(nick, results) {
    const all = [];
    for (let page = 1; ; page++) {
      if (stopRequested) break;
      await report(`제출 내역 ${page}쪽 읽는 중`);
      const doc = await fetchDoc(`/submissions?user=${encodeURIComponent(nick)}&page=${page}`);
      const items = LJParser.parseList(doc);
      all.push(...items);
      if (!items.length || !LJParser.hasPage(doc, page + 1)) break;
      await sleep(LJ_DELAY);
    }
    return all
      .filter((s) => sameUser(s.user, nick) && results.includes(s.result))
      .sort((a, b) => a.id - b.id);
  }

  async function openRepo() {
    const r = await chrome.runtime.sendMessage({ type: 'ensureRepo' });
    if (!r || !r.ok) throw new Error((r && r.error) || '저장소를 확인하지 못했습니다.');
    const base = `/repos/${r.repo.owner}/${r.repo.repo}`;
    const branch = r.repo.branch;
    const ref = await gh('GET', `${base}/git/ref/heads/${branch}`);
    let head = ref.object.sha;
    let tree = (await gh('GET', `${base}/git/commits/${head}`)).tree.sha;
    const listing = await gh('GET', `${base}/git/trees/${tree}?recursive=1`);

    const paths = new Set(listing.tree.map((t) => t.path));
    const uploaded = new Set();
    const folders = new Map(); // 문제번호 -> 이미 있는 폴더명
    for (const p of paths) {
      const parts = p.split('/');
      if (parts[0] !== ROOT || parts.length < 2) continue;
      folders.set(parts[1].split(' ')[0], parts[1]);
      const m = parts.length === 3 && parts[2].match(/^(\d+)\.md$/);
      if (m) uploaded.add(Number(m[1]));
    }

    async function commit(files, message) {
      const newTree = await gh('POST', `${base}/git/trees`, {
        base_tree: tree,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      });
      const newCommit = await gh('POST', `${base}/git/commits`, { message, tree: newTree.sha, parents: [head] });
      await gh('PATCH', `${base}/git/refs/heads/${branch}`, { sha: newCommit.sha });
      head = newCommit.sha;
      tree = newTree.sha;
      for (const f of files) paths.add(f.path);
    }

    return { paths, uploaded, folders, commit };
  }

  async function uploadOne(repo, id, nick) {
    const sub = LJParser.parseSubmission(await fetchDoc(`/submissions/${id}`));
    if (!sameUser(sub.user, nick)) throw new Error(`${sub.user} 님의 제출입니다. 내 제출만 올립니다.`);

    const folder = repo.folders.get(sub.problemId) || sanitize(`${sub.problemId} ${sub.title}`);
    const dir = `${ROOT}/${folder}`;
    const files = [{ path: `${dir}/${id}.md`, content: LJParser.submissionMarkdown(id, sub) }];

    if (!repo.paths.has(`${dir}/README.md`)) {
      await sleep(LJ_DELAY);
      const doc = await fetchDoc(`/problems/${sub.problemId}`);
      files.push({ path: `${dir}/README.md`, content: LJParser.problemMarkdown(doc, sub.problemId).markdown });
    }

    await repo.commit(files, `[${id}] ${sub.problemId} ${sub.title}, ${sub.result} - LJAutoPush`);
    repo.folders.set(sub.problemId, folder);
    repo.uploaded.add(id);
    return `[${id}] ${sub.problemId} ${sub.title}, ${sub.result}`;
  }

  async function run({ mode, nick, results, id }) {
    running = true;
    stopRequested = false;
    Object.assign(status, { running: true, done: 0, total: 0, uploaded: 0, skipped: 0, failed: 0, msg: '', log: [] });
    try {
      await report('저장소 확인 중');
      const repo = await openRepo();
      const ids = mode === 'one' ? [id] : (await collectTargets(nick, results)).map((s) => s.id);
      status.total = ids.length;
      if (!ids.length) await report('올릴 제출이 없습니다.', true);

      for (const target of ids) {
        if (stopRequested) {
          await report('중지했습니다.', true);
          break;
        }
        if (mode === 'all' && repo.uploaded.has(target)) {
          status.skipped++;
        } else {
          await report(`[${target}] 올리는 중`);
          try {
            const line = await uploadOne(repo, target, nick);
            status.uploaded++;
            await report(`올림: ${line}`, true);
          } catch (e) {
            status.failed++;
            await report(`실패: [${target}] ${e.message}`, true);
          }
          await sleep(LJ_DELAY);
        }
        status.done++;
      }
      status.running = false;
      await report(`끝. 올림 ${status.uploaded} · 건너뜀 ${status.skipped} · 실패 ${status.failed}`, true);
    } catch (e) {
      status.running = false;
      await report(`오류: ${e.message}`, true);
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ping') sendResponse({ ok: true, running });
    else if (msg.type === 'stop') {
      stopRequested = true;
      sendResponse({ ok: true });
    } else if (msg.type === 'run') {
      if (running) sendResponse({ ok: false, error: '이미 실행 중입니다.' });
      else {
        run(msg);
        sendResponse({ ok: true });
      }
    }
  });
})();
