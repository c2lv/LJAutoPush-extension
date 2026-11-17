// 검증 자동화. 팝업이 연 https://localjudge.com/verify#ljap 탭에서만 동작합니다.
// 사이트의 검증 화면에 제출 번호를 넣고 "불러오기" → "내 기기에서 다시 돌리기"를 차례로 누릅니다.
// 제출 내역(전체 또는 특정 문제)에서 고른 결과의 최신 제출부터 n개를 검증합니다.
// 검증 기록은 따로 남기지 않습니다.
//
// 검증 화면의 "불러오기"는 한 시간에 약 20번까지만 됩니다. 넘으면 "조회가 너무 잦습니다. N분 뒤에"가 나오고
// 한 시간 동안 막힙니다. 그래서 불러오기 전에 제출 화면으로 미리 걸러 내고(코드 문제, 비공개),
// 제한 메시지가 나오면 그 자리에서 멈춥니다.
(() => {
  if (location.pathname !== '/verify' || location.hash !== '#ljap') return;
  history.replaceState(null, '', location.pathname + location.search);

  const store = chrome.storage.local;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MIN = 60 * 1000;
  const LJ_DELAY = 300;
  const MAX_PAGES = 40; // 넘겨볼 제출 내역 쪽 수 (한 쪽 50건)
  const LOAD_TIMEOUT = 30 * 1000;
  const RUN_START_TIMEOUT = 15 * 1000;
  const RUN_TIMEOUT = 15 * MIN;
  const RESULT_PARAM = { ok: 'ACCEPTED', bad: 'WRONG', warn: 'BROKEN' };
  const RATE_LIMITED = /너무 잦|too (many|often)/i;

  const sameUser = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const yn = (v) => (v ? '예' : '아니오');

  const status = { kind: 'verify', running: true, done: 0, total: 0, msg: '', log: [], heartbeat: Date.now() };
  async function report(msg, keep = false) {
    if (msg !== null) status.msg = msg;
    if (keep) status.log = [...status.log, msg].slice(-200);
    status.heartbeat = Date.now();
    await store.set({ status: { ...status } });
  }

  let stopRequested = false;
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.vstop && changes.vstop.newValue) stopRequested = true;
  });

  async function fetchDoc(path) {
    const res = await fetch(location.origin + path, { credentials: 'include' });
    if (!res.ok) throw new Error(`${path} 요청 실패 (${res.status})`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  // 조건이 참이 될 때까지 기다립니다. 기다리는 동안 heartbeat를 남겨 팝업이 실행 중임을 압니다.
  async function waitFor(check, timeout) {
    const end = Date.now() + timeout;
    let beat = 0;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() > end) return null;
      if (Date.now() - beat > 5000) {
        beat = Date.now();
        await report(null);
      }
      await sleep(500);
    }
  }

  // 사이트의 제한 메시지("N분 뒤에")에서 다시 실행할 수 있는 때를 읽습니다.
  function retryHint(message) {
    const m = message.match(/(\d+)\s*분/) || message.match(/(\d+)\s*min/i);
    return m ? `${m[1]}분 뒤에 다시 실행하세요.` : '잠시 뒤에 다시 실행하세요.';
  }

  // ── 검증 화면 조작 ──
  const ui = {
    input: () => document.querySelector('main input[inputmode="numeric"]'),
    card: () => ui.input() && ui.input().closest('section.card'),
    stack: () => ui.card() && ui.card().parentElement,
    loadBtn: () => ui.card() && ui.card().querySelector('button'),
    error: () => {
      const n = ui.card() && ui.card().querySelector('.note');
      return n ? n.textContent.trim() : '';
    },
    loadedTitle: () => {
      const s = ui.stack() && ui.stack().children[1];
      const h = s && s.querySelector('h2');
      return h ? h.textContent.trim() : '';
    },
    runBtn: () => {
      const s = ui.stack() && ui.stack().children[1];
      return s ? [...s.querySelectorAll('button')].pop() : null;
    },
    result: () => ui.stack() && ui.stack().querySelector('.grid.g3'),
  };

  function setInput(value) {
    const input = ui.input();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 불러오기. 성공하면 null, 실패하면 이유를 돌려줍니다.
  async function load(subId, problemId) {
    setInput(subId);
    await sleep(100);
    ui.loadBtn().click();
    await sleep(500); // 이전 결과·오류가 지워질 때까지
    const ok = await waitFor(() => {
      if (ui.loadedTitle() && !ui.result() && (!problemId || ui.loadedTitle().startsWith(problemId))) return 'ok';
      return ui.error() ? 'err' : null;
    }, LOAD_TIMEOUT);
    if (ok === 'ok') return null;
    return ok === 'err' ? ui.error() : '불러오기 시간 초과';
  }

  async function run() {
    const btn = ui.runBtn();
    if (!btn) return { error: '다시 돌리기 버튼을 찾지 못했습니다.' };
    btn.click();
    const started = await waitFor(() => ui.runBtn() && ui.runBtn().disabled, RUN_START_TIMEOUT);
    if (!started && !ui.result()) return { error: ui.error() || '다시 돌리기가 시작되지 않았습니다.' };
    const finished = await waitFor(() => ui.runBtn() && !ui.runBtn().disabled, RUN_TIMEOUT);
    if (!finished) return { error: '다시 돌리기 시간 초과' };
    const grid = ui.result();
    if (!grid) return { error: ui.error() || '결과가 나오지 않았습니다.' };
    const [outputsMatch, passedHere, envComparable] = [...grid.children].map((c) => !!c.querySelector('.pill.ok'));
    return { outputsMatch, passedHere, envComparable };
  }

  // 불러오기 전에 제출 화면으로 미리 봅니다. 불러오기 횟수를 아끼기 위해서입니다.
  async function inspect(subId) {
    await sleep(LJ_DELAY);
    const doc = await fetchDoc(`/submissions/${subId}`);
    let visible = false;
    try {
      visible = LJParser.parseSubmission(doc).prompts.length > 0;
    } catch {}
    return { visible };
  }

  // 제출 하나를 불러와 돌립니다.
  // 결과: { ok } | { failed } | { skipped: 이유 } | { limited: 이유 }
  async function verifyOne(sub, problemId) {
    const loadError = await load(sub.id, problemId);
    if (loadError && RATE_LIMITED.test(loadError)) return { limited: `조회 제한으로 멈췄습니다. ${retryHint(loadError)}` };
    if (loadError) return { skipped: loadError };
    const label = `${problemId} · [${sub.id}]${sub.user ? ' ' + sub.user : ''}`;
    await report(`${label} 다시 돌리는 중`);
    const outcome = await run();
    // 다시 돌리기 횟수 제한("검증이 너무 잦습니다")은 불러오기 제한과 따로 걸립니다. 걸리면 멈춥니다.
    if (outcome.error && RATE_LIMITED.test(outcome.error)) {
      return { limited: `검증 제한으로 멈췄습니다. ${retryHint(outcome.error)}` };
    }
    status.done++;
    if (outcome.error) {
      await report(`실패: ${label} ${outcome.error}`, true);
      return { failed: true };
    }
    await report(`검증: ${label} · 출력 일치 ${yn(outcome.outputsMatch)} · 내 기기 통과 ${yn(outcome.passedHere)}`, true);
    return { ok: true };
  }

  // ── 대상 고르기 ──
  // 코드 문제(파이썬, 자바스크립트, SQL 등), 내 제출, 내가 풀지 않은 문제는 건너뜁니다.
  async function* listTargets(job, solvedSet) {
    const base = job.problem ? `/problems/${encodeURIComponent(job.problem)}/submissions` : '/submissions';
    const results = new Set(job.results);
    const params = new URLSearchParams();
    if (job.results.length === 1) params.set('result', RESULT_PARAM[job.results[0]]);
    for (let page = 1; page <= MAX_PAGES; page++) {
      params.set('page', page);
      await report(`제출 내역 ${page}쪽 읽는 중`);
      const doc = await fetchDoc(`${base}?${params}`);
      for (const s of LJParser.parseList(doc)) {
        const problemId = s.problem || job.problem;
        if (s.kind === 'code') {
          sawCode = true;
          continue;
        }
        if (!results.has(s.result) || sameUser(s.user, job.nick)) continue;
        if (!solvedSet.has(problemId)) continue; // 내가 풀지 않은 문제는 프롬프트가 보이지 않습니다
        yield { ...s, problemId };
      }
      if (!LJParser.hasPage(doc, page + 1)) return;
      await sleep(LJ_DELAY);
    }
  }

  let sawCode = false;

  async function runList(job, solved) {
    const solvedSet = new Set(solved);
    if (job.problem && !solvedSet.has(job.problem)) throw new Error(`${job.problem}은(는) 내가 푼 문제가 아니라 검증할 수 없습니다.`);
    const where = job.problem || '전체';
    const which = job.results.map((r) => LJParser.RESULT_LABEL[r]).join('·');
    status.total = job.max;
    await report(`${where} · ${which} 최신 제출부터 ${job.max}개 검증`, true);

    let verified = 0;
    for await (const s of listTargets(job, solvedSet)) {
      if (verified >= job.max || stopRequested) break;
      const info = await inspect(s.id);
      if (!info.visible) {
        await report(`건너뜀: [${s.id}] 프롬프트가 보이지 않습니다.`, true);
        continue;
      }
      const r = await verifyOne(s, s.problemId);
      if (r.limited) throw new LimitError(r.limited);
      if (r.skipped) await report(`건너뜀: [${s.id}] ${r.skipped}`, true);
      else if (r.ok) verified++;
    }
    if (job.problem && sawCode && !verified) {
      await report(`${job.problem}은(는) 코드 문제라 검증할 수 없습니다.`, true);
    } else if (verified < job.max && !stopRequested) {
      await report('더 검증할 제출이 없습니다.', true);
    }
    return verified;
  }

  class LimitError extends Error {}

  async function main() {
    const { vjob } = await store.get('vjob');
    if (!vjob) return;
    await store.remove(['vjob', 'vstop']);
    const job = {
      nick: '',
      max: Math.min(20, Math.max(1, Number(vjob.max) || 1)),
      results: (vjob.results || []).filter((r) => RESULT_PARAM[r]),
      problem: (vjob.problem || '').trim().toUpperCase(),
    };
    if (!job.results.length) job.results = ['ok'];

    try {
      await report('검증 화면 준비 중');
      if (!(await waitFor(() => ui.input(), 20000))) {
        throw new Error('검증 화면을 열지 못했습니다. 로컬 저지에 로그인했는지 확인하세요.');
      }
      // 닉네임은 로그인한 계정(머리말의 "/me" 링크)에서 읽습니다. 팝업의 닉네임은 쓰지 않습니다.
      job.nick = (await waitFor(() => {
        const who = document.querySelector('header a[href="/me"]');
        return who && who.textContent.trim();
      }, 10000)) || '';
      if (!job.nick) throw new Error('로그인한 계정을 찾지 못했습니다. 로컬 저지에 로그인했는지 확인하세요.');
      await report('푼 문제 목록 읽는 중');
      const solved = LJParser.parseSolved(await fetchDoc(`/u/${encodeURIComponent(job.nick)}`));
      if (!solved) throw new Error(`${job.nick} 님의 푼 문제 목록을 찾지 못했습니다.`);
      const verified = await runList(job, solved);
      if (stopRequested) await report('중지했습니다.', true);
      status.running = false;
      await report(`끝. 검증 ${verified}개`, true);
    } catch (e) {
      status.running = false;
      await report(e instanceof LimitError ? e.message : `오류: ${e.message}`, true);
    }
  }

  main();
})();
