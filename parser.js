// 로컬 저지 화면(Document)을 읽어 마크다운으로 바꾸는 순수 함수 모음.
const LJParser = (() => {
  const ORIGIN = 'https://localjudge.com';
  const RESULT_LABEL = { ok: '해결', bad: '오답', warn: '채점 깨짐' };
  const RESULT_SELECTOR = '.pill.ok, .pill.bad, .pill.warn';
  const BLOCK = new Set(['P', 'DIV', 'UL', 'OL', 'TABLE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'SECTION', 'BLOCKQUOTE']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'TEXTAREA', 'INPUT', 'LABEL']);

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cell = (s) => clean(s).replace(/\|/g, '\\|');

  function resultKey(root) {
    const pill = root && root.querySelector(RESULT_SELECTOR);
    if (!pill) return null;
    return ['ok', 'bad', 'warn'].find((k) => pill.classList.contains(k));
  }

  function fence(text, lang = '') {
    const body = text.replace(/\n+$/, '');
    const longest = Math.max(0, ...(body.match(/`+/g) || []).map((r) => r.length));
    const ticks = '`'.repeat(Math.max(3, longest + 1));
    return `${ticks}${lang}\n${body}\n${ticks}`;
  }

  function inlineCode(text) {
    return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
  }

  function inline(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        out += n.nodeValue.replace(/\s+/g, ' ').replace(/</g, '&lt;');
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (SKIP.has(tag)) continue;
      if (tag === 'BR') out += '\n';
      else if (tag === 'CODE') out += inlineCode(n.textContent);
      else if (tag === 'B' || tag === 'STRONG') {
        const t = inline(n).trim();
        if (t) out += `**${t}**`;
      } else if (tag === 'EM' || tag === 'I') {
        const t = inline(n).trim();
        if (t) out += `*${t}*`;
      } else if (tag === 'A') {
        const href = new URL(n.getAttribute('href') || '', ORIGIN).href;
        out += `[${inline(n).trim()}](${href})`;
      } else if (BLOCK.has(tag)) out += ` ${inline(n)} `;
      else out += inline(n);
    }
    return out;
  }

  function table(el) {
    const rows = [...el.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((c) => inline(c).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>'))
    );
    if (!rows.length) return '';
    const [head, ...body] = rows;
    const line = (r) => `| ${r.join(' | ')} |`;
    return [line(head), line(head.map(() => '---')), ...body.map(line)].join('\n');
  }

  function examples(el) {
    const heads = [...el.querySelectorAll('.exs-h')].map((h) => clean(h.textContent));
    const cells = [...el.querySelectorAll('pre')].map((p) => p.textContent);
    const cols = heads.length || 2;
    const out = [];
    for (let i = 0; i < cells.length; i += cols) {
      out.push(`**예시 ${i / cols + 1}**`);
      for (let c = 0; c < cols && i + c < cells.length; c++) {
        out.push(`${heads[c] || ''}\n\n${fence(cells[i + c])}`.trim());
      }
    }
    return out.join('\n\n');
  }

  function blocks(el) {
    const out = [];
    for (const c of el.children) {
      const tag = c.tagName;
      if (SKIP.has(tag)) continue;
      let md = '';
      if (/^H[1-4]$/.test(tag)) md = `## ${clean(c.textContent)}`;
      else if (tag === 'P') md = inline(c).trim();
      else if (tag === 'UL' || tag === 'OL') {
        md = [...c.children]
          .filter((li) => li.tagName === 'LI')
          .map((li, i) => (tag === 'OL' ? `${i + 1}. ` : '- ') + clean(inline(li)))
          .join('\n');
      } else if (tag === 'PRE') md = fence(c.textContent);
      else if (tag === 'TABLE') md = table(c);
      else if (c.classList.contains('exs')) md = examples(c);
      else {
        const hasBlock = [...c.children].some((x) => BLOCK.has(x.tagName));
        md = hasBlock ? blocks(c).join('\n\n') : inline(c).trim();
        if (md && c.classList.contains('note')) {
          md = md.split('\n').map((l) => `> ${l}`).join('\n');
        }
      }
      if (md) out.push(md);
    }
    return out;
  }

  // 제출 내역 한 쪽: [{ id, user, result }]
  function parseList(doc) {
    const items = new Map();
    for (const tr of doc.querySelectorAll('tr')) {
      const link = tr.querySelector('a[href^="/submissions/"]');
      const id = link && Number(link.getAttribute('href').split('/')[2]);
      if (!id) continue;
      const user = tr.querySelector('a[href^="/u/"]');
      items.set(id, {
        id,
        user: user ? decodeURIComponent(user.getAttribute('href').slice(3)) : '',
        result: resultKey(tr),
      });
    }
    return [...items.values()];
  }

  function hasPage(doc, page) {
    return [...doc.querySelectorAll('a[href*="page="]')].some((a) =>
      new URL(a.getAttribute('href'), ORIGIN).searchParams.get('page') === String(page)
    );
  }

  // 제출 하나 보기
  function parseSubmission(doc) {
    const main = doc.querySelector('main');
    const h1 = main && main.querySelector('h1');
    const info = main && main.querySelector('section.card table');
    const problemLink = info && info.querySelector('a[href^="/problems/"]');
    if (!h1 || !problemLink) throw new Error('제출 화면을 읽지 못했습니다.');

    const pillRow = h1.nextElementSibling;
    const pills = pillRow ? [...pillRow.querySelectorAll('.pill')] : [];
    const key = resultKey(pillRow);
    const userLink = info.querySelector('a[href^="/u/"]');

    const rows = [...info.querySelectorAll('tr')]
      .filter((tr) => tr.children.length >= 2)
      .map((tr) => {
        const [k, v] = tr.children;
        const value = v.querySelector('a[href^="/problems/"]') ? v.textContent : (v.firstElementChild || v).textContent;
        return [clean(k.textContent), clean(value)];
      });

    const stacks = main.querySelectorAll('.grid.g2 > .stack');
    const envCard = stacks[0] && stacks[0].querySelectorAll(':scope > section.card')[1];
    const envTitle = envCard && envCard.querySelector('h2');
    const envText = envCard && envCard.querySelector('p');
    const promptCard = stacks[1] && stacks[1].querySelector('section.card');
    const prompts = promptCard
      ? [...promptCard.querySelectorAll('pre')].map((pre) => {
          const prev = pre.previousElementSibling;
          return { label: prev && prev.tagName === 'DIV' ? clean(prev.textContent) : '', text: pre.textContent };
        })
      : [];

    return {
      problemId: problemLink.getAttribute('href').split('/')[2],
      title: clean(h1.textContent),
      user: userLink ? decodeURIComponent(userLink.getAttribute('href').slice(3)) : '',
      resultKey: key,
      result: RESULT_LABEL[key] || (pills[0] ? clean(pills[0].textContent) : ''),
      tags: pills.filter((p) => !p.matches(RESULT_SELECTOR)).map((p) => clean(p.textContent)),
      rows,
      env: envText ? { label: clean(envTitle && envTitle.textContent) || '돌린 환경', text: clean(envText.textContent) } : null,
      promptTitle: clean(promptCard && promptCard.querySelector('h2') && promptCard.querySelector('h2').textContent) || '프롬프트',
      prompts,
    };
  }

  function submissionMarkdown(id, sub) {
    const isPython = sub.tags.some((t) => /python/i.test(t));
    const lines = [
      `# [${id}] ${sub.problemId} ${sub.title}`,
      '',
      `[제출 보기](${ORIGIN}/submissions/${id}) · [문제 보기](${ORIGIN}/problems/${sub.problemId})`,
      '',
      '| 항목 | 내용 |',
      '| --- | --- |',
      `| 결과 | ${cell(sub.result)} |`,
    ];
    if (sub.tags.length) lines.push(`| 채점 | ${cell(sub.tags.join(' · '))} |`);
    for (const [k, v] of sub.rows) lines.push(`| ${cell(k)} | ${cell(v)} |`);
    if (sub.env) lines.push(`| ${cell(sub.env.label)} | ${cell(sub.env.text)} |`);
    lines.push('', `## ${sub.promptTitle}`, '');
    if (!sub.prompts.length) lines.push('본문을 볼 수 없는 제출입니다.', '');
    for (const p of sub.prompts) {
      if (p.label) lines.push(`### ${p.label}`, '');
      lines.push(fence(p.text, isPython || /파이썬|python/i.test(p.label) ? 'python' : ''), '');
    }
    return lines.join('\n');
  }

  // 문제 화면 -> README.md
  function problemMarkdown(doc, problemId) {
    const main = doc.querySelector('main');
    const h1 = main && main.querySelector('h1');
    if (!h1) throw new Error('문제 화면을 읽지 못했습니다.');
    const title = clean(h1.textContent);
    const pillRow = h1.nextElementSibling;
    const tags = pillRow ? [...pillRow.querySelectorAll('.pill')].map((p) => clean(p.textContent)) : [];

    let description = '';
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        if (data.educationalLevel) tags.push(data.educationalLevel);
        if (data.keywords) tags.push(...String(data.keywords).split(',').map(clean));
        if (data.description) description = clean(data.description);
      } catch {}
    }

    const stack = main.querySelector('.grid.g2 > .stack');
    const cards = stack
      ? [...stack.querySelectorAll(':scope > section.card')]
      : [...main.querySelectorAll('section.card')].filter((c) => !c.closest('.solver-sticky'));

    const lines = [`# [${problemId}] ${title}`, '', `[문제 보기](${ORIGIN}/problems/${problemId})`, ''];
    if (description) lines.push(`> ${description}`, '');
    if (tags.length) lines.push('## 분류', '', [...new Set(tags.filter(Boolean))].join(', '), '');
    for (const card of cards) lines.push(blocks(card).join('\n\n'), '');
    return { title, markdown: lines.join('\n') };
  }

  return { RESULT_LABEL, parseList, hasPage, parseSubmission, submissionMarkdown, problemMarkdown };
})();
