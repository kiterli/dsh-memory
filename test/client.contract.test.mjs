// Contract tests for the client page (shared task task-5, teammate mem-ui).
//
//   node --test dsh-memory/test/client.contract.test.mjs
//
// They render the *real* ../client.js with the *real* mock that dev/preview.html carries, both
// headlessly (dev/react-lite.js html mode) and mounted into a stand-in DOM (dev/dom-shim.mjs), and
// check the parts of dsh-memory/CONTRACT.md that this file owns: the loader envelope, the two slot
// registrations, the six regions and their strings, the allowed design tokens, locale coverage, and
// the optional-safety of every read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../dev/render-preview.mjs';
import { createDocument, findAll, text } from '../dev/dom-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = readFileSync(join(root, 'client.js'), 'utf8');
const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const ALLOWED_TOKENS = [
  'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3',
  'label-primary', 'label-secondary', 'label-tertiary',
  'border-l1', 'border-l2', 'brand-primary',
  'state-success-primary', 'state-warn-primary', 'state-error-primary',
];

test('loader envelope: id, factory(require) and the slots inject', async () => {
  const r = await render();
  assert.equal(r.id, '@local/dsh-memory');
  // `r` comes back from a vm context, so its arrays have that realm's prototype; copy before
  // comparing or deepEqual reports "same structure but not reference-equal".
  // `slots` is required. `locale` is declared too so ctx.locale.register() is permitted —
  // an undeclared service read throws a teaching error via the host's rejectGuard. `styles`
  // is deliberately absent: a factory-form bundle has no `styles` closure parameter, so the
  // stylesheet is appended to document.head during factory evaluation instead.
  assert.deepEqual([...r.inject].sort(), ['locale', 'slots']);
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /const React = require\('react'\)/);
  assert.match(source, /const h = React\.createElement/);
  assert.equal(source.includes('jsx'), false, 'must not rely on JSX');
});

test('slot registrations: sidebar.panellist@41 and the keyed main page', async () => {
  const r = await render();
  const sidebar = r.regs.find((x) => x.name === 'sidebar.panellist');
  const main = r.regs.find((x) => x.name === 'main');
  assert.equal(sidebar.id, 'dsh-memory');
  assert.equal(sidebar.order, 41);
  assert.equal(sidebar.label, '记忆');
  assert.equal(main.key, 'dsh-memory');
  assert.ok(main.Component, 'main registration carries a component');
  assert.match(source, /data-dsh-panel-entry/, 'sidebar icon carries the panel entry attribute');
});

test('all six regions render from the contract strings', async () => {
  const r = await render();
  const t = strip(r.html);
  const expected = [
    '记忆', 'Holographic', '本地记忆：Markdown 记忆文件 + Holographic 事实库', '只读', '刷新',
    '内置条目', 'MEMORY.md + USER.md', '启用的记忆提供方', 'Holographic 事实', '快照更新时间',
    '记忆筛选', '内容、事实或标签...', '全部分类', '最低信任度', '应用筛选',
    '内置记忆', '字符用量', '已用', '这个记忆文件还没有条目。',
    '已配置的记忆提供方', '已配置', '事实', '显示', '实体', '记忆库', '概览', '信任度', '检索到', '有帮助',
    '会话搜索', '全部来源', '最新优先', '搜索会话',
  ];
  const missing = expected.filter((s) => !t.includes(s));
  assert.deepEqual(missing, [], 'missing region strings');
  // ORDER of the four panels, as CONTRACT.md lists them. Read the headings, not raw text: the
  // mock MEMORY.md entry #5 legitimately contains the words 会话搜索, and indexOf on the whole
  // document then reports the panels as out of order.
  const headings = [...r.html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => strip(m[1]).trim()).filter(Boolean);
  assert.deepEqual(headings, ['记忆筛选', '内置记忆', '已配置的记忆提供方', '会话搜索'], 'panels out of contract order');
});

test('built-in files: budget line, integer percent, entries and the unavailable state', async () => {
  const r = await render();
  const t = strip(r.html);
  assert.match(t, /字符用量 1,?840 \/ 2,?200 字符/);
  assert.match(t, /已用 \d+%/);
  assert.equal(/已用 \d+\.\d+%/.test(t), false, 'percent is an integer, as the panel prints it');
  assert.match(t, /#1/);
  assert.match(t, /不可用/);
  assert.ok(t.includes('这个记忆文件还没有条目。'), 'USER.md renders its empty state');
  assert.match(t, /可用/);
});

test('fact cards: trust toFixed(3), counted x-suffixes and tag chips', async () => {
  const r = await render();
  const t = strip(r.html);
  assert.match(t, /信任度 0\.9\d\d/, 'trust renders with three decimals');
  assert.match(t, /检索到 \d+x/, 'search counter uses the ASCII x of CONTRACT.md');
  assert.match(t, /有帮助 \d+x/, 'helpful counter uses the ASCII x of CONTRACT.md');
  assert.equal(t.includes('×'), false);
  assert.equal(/信任度 \d\.\d\d(?!\d)/.test(t), false, 'never fewer than three decimals');
});

test('a zero trust still renders 0.000, and bare-string entries are not dropped', async () => {
  const r = await render({
    mutate(mock) {
      mock.facts[0].trust = 0;
      mock.builtinFiles[0].entries = ['裸字符串条目', { content: '对象里的 content' }, { value: '对象里的 value' }];
    },
  });
  const t = strip(r.html);
  assert.match(t, /信任度 0\.000/);
  assert.ok(t.includes('裸字符串条目'), 'a bare string entry renders');
  assert.ok(t.includes('对象里的 content'), 'an object entry with content renders');
  assert.ok(t.includes('对象里的 value'), 'an object entry with value renders');
  assert.equal(t.includes('undefined'), false, 'no field leaks as undefined');
});

test('optional safety: failing endpoints show the error strip and keep the rest alive', async () => {
  const r = await render({ failAll: true });
  const t = strip(r.html);
  assert.ok(t.includes('部分数据加载失败'), 'inline error strip renders');
  assert.ok(t.includes('503') || t.includes('请求失败'), 'the strip names the failure');
  assert.equal(r.html.includes('class="mm-fact"'), false, 'no fact card without data');
  for (const keep of ['记忆筛选', '内置记忆', '字符用量', '这个记忆文件还没有条目。', '会话搜索', '全部来源']) {
    assert.ok(t.includes(keep), 'region survives a failing neighbour: ' + keep);
  }
  assert.ok(r.calls.some((c) => c.includes('503')), 'the failure was actually simulated');
});

test('optional safety: a payload with no fields neither throws nor blanks the page', async () => {
  const r = await render({
    mutate(mock, sandbox) {
      const real = sandbox.fetch;
      sandbox.fetch = (url, init) => {
        const p = String(url);
        if (p.includes('/overview')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        if (p.includes('/builtin')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null) });
        if (p.includes('/facts')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, facts: 'not-an-array' }) });
        return real(url, init);
      };
    },
  });
  const t = strip(r.html);
  assert.ok(t.includes('记忆筛选'), 'the page still renders');
  assert.ok(t.includes('—') || t.includes('这个记忆文件还没有条目。'), 'empty values degrade to the placeholder');
  assert.equal(r.html.includes('undefined'), false);
});

test('design tokens: only the CONTRACT allow-list, and no literal colour', () => {
  const used = new Set();
  for (const m of source.matchAll(/--dsw-alias-([a-z0-9-]+)/g)) used.add(m[1]);
  assert.deepEqual([...used].sort(), ALLOWED_TOKENS.slice().sort(), 'token set differs from CONTRACT.md');
  // Comments are allowed to name colours (the divergence note does); code is not.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const hex = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual(hex, [], 'colours must come from tokens, not literals');
  assert.match(source, /--dsw-radius-/, 'radius comes from the DSH shell');
});

test('locale dicts: zh and en cover every key used, Chinese first', () => {
  const zhStart = source.indexOf('\n      zh: {');
  const enStart = source.indexOf('\n      en: {');
  assert.ok(zhStart > 0 && enStart > zhStart, 'DICTS.zh and DICTS.en found');
  const keysOf = (body) => new Set([...body.matchAll(/'([a-zA-Z][\w.]*)':/g)].map((m) => m[1]));
  const zh = keysOf(source.slice(zhStart, enStart));
  const en = keysOf(source.slice(enStart, source.indexOf('\n    };', enStart)));
  const usedKeys = new Set([...source.matchAll(/\btt\('([a-zA-Z][\w.]*)'/g)].map((m) => m[1]));
  assert.ok(zh.size > 50, 'zh dict looks complete');
  assert.deepEqual([...usedKeys].filter((k) => !zh.has(k)), [], 'keys used but missing from zh');
  assert.deepEqual([...usedKeys].filter((k) => !en.has(k)), [], 'keys used but missing from en');
  assert.deepEqual([...zh].sort(), [...en].sort(), 'zh and en must carry the same keys');
  const zhBody = source.slice(zhStart, enStart);
  for (const k of ['page.title', 'builtin.empty', 'sessions.title']) {
    const m = new RegExp("'" + k.replace('.', '\\.') + "': '([^']*)'").exec(zhBody);
    assert.ok(m, k + ' missing from the zh dict');
    assert.match(m[1], /[\u4e00-\u9fff]/, k + ' must have a Chinese value');
  }
});

test('locale files stay minimal and match the template shape', () => {
  const zh = JSON.parse(readFileSync(join(root, 'locale/zh.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(root, 'locale/en.json'), 'utf8'));
  assert.deepEqual(Object.keys(zh), ['meta']);
  assert.equal(zh.meta.title, '记忆');
  assert.deepEqual(Object.keys(zh.meta).sort(), Object.keys(en.meta).sort());
});

test('mounted page: renders, refreshes, marks a fact helpful and survives a later failure', async () => {
  const document = createDocument();
  const r = await render({ mount: true, document });
  const container = r.container;
  assert.ok(container, 'mounted into the stand-in DOM');
  const titles = () => findAll(container, (n) => n.tagName === 'H3').map((n) => text(n));
  assert.deepEqual(titles(), ['记忆筛选', '内置记忆', '已配置的记忆提供方', '会话搜索']);
  assert.ok(text(container).includes('字符用量'), 'content rendered in DOM mode');

  // The page's own refresh path: POST /refresh then re-read everything.
  const refresh = findAll(container, (n) => n.tagName === 'BUTTON' && n.getAttribute('title') === '刷新')[0];
  assert.ok(refresh, 'refresh button present');
  r.mock.calls.length = 0;
  refresh.dispatch('click');
  await r.flush(40);
  assert.ok(r.mock.calls.some((c) => c.startsWith('POST /refresh')), 'click POSTs /refresh: ' + r.mock.calls.join(' | '));
  assert.ok(r.mock.calls.some((c) => c.startsWith('GET /overview')), 'click re-reads the overview');

  // The helpful chip POSTs and ignores failure silently.
  const helpful = findAll(container, (n) => n.className && String(n.className).includes('mm-chipbtn'))[0];
  assert.ok(helpful, 'a helpful chip exists');
  r.mock.calls.length = 0;
  helpful.dispatch('click');
  await r.flush(40);
  assert.ok(
    r.mock.calls.some((c) => /^POST \/facts\/.+\/helpful/.test(c)),
    'helpful chip POSTs to the fact route: ' + r.mock.calls.join(' | '),
  );

  // Now break the facts endpoint and refresh again: the strip appears, the page survives.
  r.mock.state.failFacts = true;
  refresh.dispatch('click');
  await r.flush(40);
  assert.ok(text(container).includes('部分数据加载失败'), 'error strip after the endpoint breaks');
  assert.ok(text(container).includes('会话搜索'), 'the page is still alive');
  if (r.unmount) r.unmount();
});
