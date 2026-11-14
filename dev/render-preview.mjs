// Headless renderer for the standalone preview page (dev/preview.html).
//
//   node dev/render-preview.mjs              -> dev/preview-snapshot.html  (happy path)
//   node dev/render-preview.mjs --fail       -> dev/preview-snapshot.html  (every fact/provider read 503s)
//
// It runs the *same* mock that preview.html carries in its #mock-data script and the *same*
// unmodified ../client.js, so the snapshot proves what a browser shows. No DOM is required:
// dev/react-lite.js serialises the tree itself, and client.js injects its own <style> element
// (the ctx.styles fallback) which this runner captures and inlines.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const REGIONS = [
  ['header', '记忆', '只读'],
  ['stat cards', '内置条目', '启用的记忆提供方', 'Holographic 事实', '快照更新时间'],
  ['记忆筛选', '记忆筛选', '应用筛选', '最低信任度', '全部分类'],
  ['内置记忆', '内置记忆', '字符用量', '已用', 'MEMORY.md', 'USER.md'],
  ['已配置的记忆提供方', '已配置的记忆提供方', '信任度', '检索到', '有帮助'],
  ['会话搜索', '会话搜索', '全部来源', '最新优先'],
];
// In degraded mode /facts and /providers answer 503, so their panels show the error strip; the
// other four regions must still be fully rendered.
const DEGRADED_ALWAYS = [
  '只读', '应用筛选', '最低信任度', '全部分类', '字符用量', '已用',
  'MEMORY.md', 'USER.md', '全部来源', '最新优先', '部分数据加载失败',
];
const DEGRADED_ABSENT = ['检索到'];
// Structural check: no fact card may survive when the facts endpoint fails (the mock's MEMORY.md
// entries also contain the word 有帮助, so a text search alone is not trustworthy).
const FACT_CARD = 'class="mm-fact"';

function scriptBody(html, id) {
  const m = new RegExp('<script id="' + id + '">([\\s\\S]*?)<\\/script>').exec(html);
  if (!m) throw new Error('preview.html: script #' + id + ' not found');
  return m[1];
}

export async function render(opts) {
  const o = opts || {};
  const preview = readFileSync(join(here, 'preview.html'), 'utf8');
  const tokens = readFileSync(join(here, 'tokens.css'), 'utf8');

  // Minimal document shim: enough for client.js's "no ctx.styles" fallback to insert <style>.
  // A caller may pass its own (test/client.contract.test.mjs passes dev/dom-shim.mjs).
  const styleNodes = [];
  const document = o.document || {
    head: { appendChild: (n) => { styleNodes.push(n); return n; } },
    getElementById: () => null,
    createElement: () => ({ tagName: 'STYLE', id: '', textContent: '' }),
  };

  const sandbox = { console, setTimeout, clearTimeout };
  const ctx = vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.document = document;

  const run = (code, filename) => vm.runInContext(code, ctx, { filename });
  run(scriptBody(preview, 'mock-data'), 'preview.html#mock-data');

  const mock = sandbox.__DSH_MEMORY_MOCK;
  if (o.failAll || o.failFacts) mock.state.failFacts = true;
  if (o.failAll || o.failProviders) mock.state.failProviders = true;
  mock.calls.length = 0;
  if (typeof o.mutate === 'function') o.mutate(mock, sandbox);

  run(scriptBody(preview, 'loader-stub'), 'preview.html#loader-stub');
  run(readFileSync(join(here, 'react-lite.js'), 'utf8'), 'dev/react-lite.js');
  run(readFileSync(join(root, 'client.js'), 'utf8'), 'dsh-memory/client.js');

  const entry = sandbox.__DSH_MEMORY_ENTRY;
  if (!entry) throw new Error('client.js did not register itself with window.__ModuleLoader__');
  const React = sandbox.__ReactLite;
  const mod = entry.factory(sandbox.__ModuleLoader__.require);

  const regs = [];
  const host = {
    // Deliberately no styles / locale / slots-absence: the degradation paths must hold.
    slots: {
      inject(name, cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
      register(reg, Component) {
        regs.push({
          name: reg.name, id: reg.id, key: reg.key, order: reg.order,
          label: typeof reg.label === 'function' ? reg.label() : reg.label,
          componentName: Component && Component.name, Component,
        });
        return () => {};
      },
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  };
  mod.apply(host);

  const main = regs.filter((r) => r.name === 'main').pop();
  if (!main || !main.Component) throw new Error('client.js registered no main page component');
  const flush = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 25 : ms));

  // Optional DOM-mode mount, for exercising the interactive path (click handlers, re-render).
  let container = null;
  let unmount = null;
  if (o.mount) {
    container = document.createElement('div');
    if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(container);
    const mounted = React.mount(React.createElement(main.Component), container);
    // React.mount hands back a handle ({ unmount }), not a bare function; callers want to write
    // `unmount()` so the handle is flattened here.
    unmount = typeof mounted === 'function' ? mounted : () => mounted && mounted.unmount && mounted.unmount();
    await flush(o.settleMs === undefined ? 30 : o.settleMs);
  }

  // Serialising switches react-lite into "html" mode, so it is only done when nothing is mounted.
  const html = o.mount ? '' : await React.toHtmlAsync(React.createElement(main.Component), { settleMs: 5 });

  return {
    id: entry.id,
    inject: mod.inject,
    regs,
    html,
    css: styleNodes.map((n) => n.textContent).join('\n') || (document.__styleText || ''),
    calls: mock.calls.slice(),
    mock,
    sandbox,
    container,
    unmount,
    flush,
  };
}

export function snapshotDocument(result, tokens) {
  return [
    '<!doctype html>',
    '<html lang="zh-CN" data-theme="light">',
    '<head><meta charset="utf-8"><title>dsh-memory 记忆 — rendered snapshot</title>',
    '<style>',
    tokens,
    result.css,
    '.snap{padding:16px;}',
    '</style></head>',
    '<body><div class="snap"><div class="pv-frame">',
    result.html,
    '</div></div></body></html>',
    '',
  ].join('\n');
}

async function main() {
  const fail = process.argv.includes('--fail');
  const result = await render({ failAll: fail });
  const tokens = readFileSync(join(here, 'tokens.css'), 'utf8');
  const out = join(here, fail ? 'preview-snapshot-error.html' : 'preview-snapshot.html');
  writeFileSync(out, snapshotDocument(result, tokens), 'utf8');

  const text = result.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const missing = [];
  const found = [];
  if (fail) {
    for (const needle of DEGRADED_ALWAYS) (text.indexOf(needle) === -1 ? missing : found).push(needle);
    for (const needle of DEGRADED_ABSENT) if (text.indexOf(needle) !== -1) missing.push(needle + ' (should be absent: its endpoint 503s)');
    if (result.html.indexOf(FACT_CARD) !== -1) missing.push('fact cards (should be absent: /facts 503s)');
    else found.push('no fact cards, error strip shown');
  } else {
    for (const group of REGIONS) {
      for (const needle of group.slice(1)) if (text.indexOf(needle) === -1) missing.push(needle);
    }
    if (result.html.indexOf(FACT_CARD) === -1) missing.push('fact cards');
    found.push('all six regions');
  }
  console.log('mode          : ' + (fail ? 'degraded (facts + providers return 503)' : 'happy path'));
  console.log('module id     : ' + result.id + '   inject: ' + JSON.stringify(result.inject));
  console.log('registrations : ' + result.regs.map((r) => r.name + (r.id ? '#' + r.id : '') + (r.order ? '@' + r.order : '')).join(', '));
  console.log('api calls     : ' + result.calls.length + '  (' + result.calls.join(' | ') + ')');
  console.log('markup        : ' + result.html.length + ' chars, inline css ' + result.css.length + ' chars');
  console.log('checked       : ' + (fail ? DEGRADED_ALWAYS.length + ' mandatory + ' + DEGRADED_ABSENT.length + ' forbidden' : 'six regions') + ' -> ' + (missing.length ? 'MISSING ' + missing.join(', ') : 'all present'));
  console.log('written       : ' + out);
  if (missing.length) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('render-preview.mjs')) {
  main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
}
