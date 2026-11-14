/**
 * End-to-end test for the agent interface: does memory actually GET USED?
 *
 * This is the test that answers "我让它记住的时候有没有记住". It mounts the real plugin
 * against a fake cordis context that implements `tools` / `systemPrompt` / `agent/pre-step`
 * the way DSH does, then:
 *
 *   1. asserts the four memory tools registered,
 *   2. calls the real `memory_record` execute() and asserts the fact landed in the store,
 *   3. asserts the instruction section tells the model to record "记住",
 *   4. drives a real agent/pre-step waterfall and asserts memory was injected into the
 *      messages the model receives,
 *   5. calls memory_search and asserts the recorded fact comes back,
 *   6. calls memory_forget and asserts it is gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// See test/routes.test.mjs: the embedder's Worker ports outlive terminate() in Node 22,
// so tests run HRR-only and let the process exit.
process.env.DSH_MEMORY_NO_EMBED = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const indexUrl = pathToFileURL(path.join(pluginRoot, 'index.js')).href;

/* ------------------------------------------------------------ fake cordis ctx */

function makeCtx() {
  const tools = new Map();
  const sections = [];
  const contexts = [];
  const listeners = [];
  const provided = new Map();
  const logs = [];
  const effectDisposers = [];

  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    webServer: { register: () => () => {} },
    tools: {
      register(def) {
        if (!def?.name) throw new Error('tool needs a name');
        if (!def.output || typeof def.output.render !== 'function') throw new Error(`tool ${def.name} needs output.render`);
        if (tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
      guard: () => () => {},
    },
    systemPrompt: {
      section(sec) {
        if (!Number.isFinite(sec.order)) throw new Error('section order must be finite');
        sections.push(sec);
        return () => {};
      },
      context(c) {
        contexts.push(c);
        return () => {};
      },
      getSectionOrder: () => 2300,
      getContextOrder: () => 210,
    },
    on(event, handler) {
      listeners.push({ event, handler });
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      effectDisposers.push(dispose);
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    provide(key, value) {
      provided.set(key, value);
    },
    get(key) {
      return provided.get(key);
    },
  };
  return { ctx, tools, sections, contexts, listeners, provided, logs, effectDisposers };
}

/** Release the store handle before the temp dir is removed (Windows refuses unlink otherwise). */
async function teardown(effectDisposers) {
  for (const dispose of effectDisposers) {
    try {
      await (typeof dispose === 'function' ? dispose() : undefined);
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 120));
}

/** Run the agent/pre-step waterfall the way dsh-agent does: handlers wrap `next()`. */
async function runPreStep(listeners, { messages }) {
  const terminal = async () => ({ kind: 'enter', messages: [...messages] });
  let chain = terminal;
  const handlers = listeners.filter((l) => l.event === 'agent/pre-step');
  // Prepend handlers run LAST (they observe the final claimed batch), so compose in order.
  for (const { handler } of handlers) {
    const inner = chain;
    chain = async () => handler({ agent: {}, messages, signal: { aborted: false } }, inner);
  }
  return chain();
}

const invoke = async (tool, args) => tool.execute(args, { name: tool.name });

/* --------------------------------------------------------------------- tests */

test('agent interface: tools register, record persists, recall injects, search finds', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-memory-agent-'));
  const prevHome = process.env.DSH_MEMORY_HOME;
  process.env.DSH_MEMORY_HOME = home;
  t.after(async () => {
    await teardown(effectDisposers);
    if (prevHome === undefined) delete process.env.DSH_MEMORY_HOME;
    else process.env.DSH_MEMORY_HOME = prevHome;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  const { apply } = await import(indexUrl);
  const { ctx, tools, sections, listeners, logs, effectDisposers } = makeCtx();
  apply(ctx, {});

  // Wait for the async bootstrap to finish mounting the agent surface.
  for (let i = 0; i < 60 && tools.size === 0; i += 1) await new Promise((r) => setTimeout(r, 20));

  // --- 1. the four tools exist -------------------------------------------
  assert.equal(tools.size, 4, `expected 4 memory tools, got ${tools.size}: ${[...tools.keys()]}`);
  for (const name of ['memory_record', 'memory_search', 'memory_list', 'memory_forget']) {
    assert.ok(tools.has(name), `missing tool ${name}`);
  }
  for (const tool of tools.values()) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} has execute`);
    assert.ok(tool.description.length > 40, `${tool.name} has a real description`);
    assert.ok(tool.parameters, `${tool.name} declares parameters`);
  }

  // --- 2. the instruction section tells the model to record "记住" ---------
  assert.ok(sections.length >= 1, 'an instruction section was registered');
  const section = sections.find((s) => s.name === 'tool:dsh-memory');
  assert.ok(section, 'the dsh-memory instruction section exists');
  const text = typeof section.text === 'function' ? section.text() : section.text;
  assert.match(text, /memory_record/, 'the section names the tool the model must call');
  assert.match(text, /记住/, 'the section quotes the phrasing that should trigger a record');
  assert.ok(text.includes('durable'), 'the section distinguishes durable facts from turn-local detail');

  // --- 3. recording a fact actually persists ------------------------------
  const record = tools.get('memory_record');
  const saved = await invoke(record, {
    content: '用户偏好中文回答，界面文案与文档一律中文优先。',
    category: '偏好',
    tags: ['语言', '沟通'],
    trust: 0.95,
  });
  assert.ok(saved.id, 'record returned an id');
  assert.equal(saved.created, true, 'first write creates a fact');
  assert.equal(saved.total, 1, 'store now holds one fact');

  // The rendered output must be human-readable, not raw JSON.
  const rendered = record.output.render({}, saved);
  assert.ok(Array.isArray(rendered) && rendered[0].type === 'text', 'record renders text blocks');
  assert.match(rendered[0].text, /已记住/, 'confirmation is visible in the transcript');

  // A duplicate write updates instead of creating a second row.
  const again = await invoke(record, { content: '用户偏好中文回答，界面文案与文档一律中文优先。', category: '偏好' });
  assert.equal(again.created, false, 'same content updates rather than duplicates');
  assert.equal(again.total, 1, 'still one fact');

  // --- 4. the fact is really in the store, not just in the return value ---
  const list = tools.get('memory_list');
  const listed = await invoke(list, {});
  assert.equal(listed.total, 1);
  assert.match(listed.facts[0].content, /中文/, 'the stored content matches');

  // --- 5. recall injects memory into the messages the model sees -----------
  const decision = await runPreStep(listeners, { messages: [{ role: 'user', content: '我平时习惯用什么语言？' }] });
  assert.equal(decision.kind, 'enter');
  assert.ok(decision.messages.length > 1, 'recall appended a message');
  const injected = decision.messages[decision.messages.length - 1];
  const injectedText = typeof injected.content === 'string' ? injected.content : JSON.stringify(injected.content);
  assert.match(injectedText, /我(?:以下是我)?记得的事情|dsh-memory context/, 'the injected message is labelled as memory context');
  assert.match(injectedText, /中文/, 'the stored preference reached the model context');

  // --- 6. search finds it by different wording (keyword + holographic) -----
  const search = tools.get('memory_search');
  const found = await invoke(search, { query: '回答语言偏好' });
  assert.ok(found.count >= 1, `search found the fact (count=${found.count})`);
  assert.match(found.facts[0].content, /中文/);
  const searchRendered = search.output.render({}, found);
  assert.match(searchRendered[0].text, /找到/, 'search renders a readable summary');

  // --- 7. forget removes it -----------------------------------------------
  const forget = tools.get('memory_forget');
  const gone = await invoke(forget, { id: saved.id });
  assert.equal(gone.removed, true);
  assert.equal(gone.total, 0, 'store is empty again');

  // --- 8. nothing threw along the way ------------------------------------
  const errors = logs.filter(([level]) => level === 'error');
  assert.equal(errors.length, 0, `no error logs: ${JSON.stringify(errors)}`);
});

test('render signature is (args, value) — a single-arg render silently shows args', async (t) => {
  // Regression guard. DSH calls `output.render(args, value)`:
  //   render(args, value) { return assertRenderedContent(cloneJson(rawRender(args, value), …)) }
  // Writing `render: (value) => …` therefore receives the ARGUMENTS object, so every field
  // read from `value` is undefined — the tool looks like it did nothing while the store
  // actually recorded correctly. This happened: record said "共 ? 条" and list said "记忆库是空的"
  // against a database that really held two facts.
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-memory-render-'));
  const prevHome = process.env.DSH_MEMORY_HOME;
  process.env.DSH_MEMORY_HOME = home;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.DSH_MEMORY_HOME;
    else process.env.DSH_MEMORY_HOME = prevHome;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  const { apply } = await import(indexUrl);
  const { ctx, tools, effectDisposers } = makeCtx();
  apply(ctx, {});
  for (let i = 0; i < 60 && tools.size === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  t.after(async () => { await teardown(effectDisposers); });

  const record = tools.get('memory_record');
  const saved = await invoke(record, { content: '渲染签名回归测试', category: '测试', trust: 0.9 });

  // arguments deliberately differ from the value: if render confuses them, the numbers lie
  const args = { content: '参数里的内容', category: '参数分类', limit: 99 };
  const blocks = record.output.render(args, saved);

  assert.ok(Array.isArray(blocks) && blocks[0]?.type === 'text', 'render returns text blocks');
  assert.match(blocks[0].text, /已记住/, 'created=true comes from the VALUE, not the args');
  assert.match(blocks[0].text, /共 1 条/, `the count comes from the VALUE, not the args (got: ${blocks[0].text})`);
  assert.doesNotMatch(blocks[0].text, /\?/, 'no unresolved placeholder — that was the bug symptom');

  const list = tools.get('memory_list');
  const listed = await invoke(list, {});
  const listBlocks = list.output.render({ limit: 5 }, listed);
  assert.doesNotMatch(listBlocks[0].text, /记忆库是空的/, 'a non-empty store must not render as empty');
  assert.match(listBlocks[0].text, /共 1 条记忆/, 'list renders the real total');
});

test('agent interface: an empty store still registers tools and degrades safely', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-memory-agent2-'));
  const prevHome = process.env.DSH_MEMORY_HOME;
  process.env.DSH_MEMORY_HOME = home;
  t.after(async () => {
    await teardown(effectDisposers);
    if (prevHome === undefined) delete process.env.DSH_MEMORY_HOME;
    else process.env.DSH_MEMORY_HOME = prevHome;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  const { apply } = await import(indexUrl);
  const { ctx, tools, listeners, effectDisposers } = makeCtx();
  apply(ctx, {});
  for (let i = 0; i < 60 && tools.size === 0; i += 1) await new Promise((r) => setTimeout(r, 20));

  // With an empty store, search must return zero results rather than throwing.
  const search = tools.get('memory_search');
  const empty = await invoke(search, { query: 'anything at all' });
  assert.equal(empty.count, 0, 'empty store yields no results');
  assert.match(search.output.render({}, empty)[0].text, /没有匹配/, 'empty search renders a friendly message');

  // Recall with no memory must simply pass the decision through unchanged.
  const decision = await runPreStep(listeners, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 1, 'nothing injected when there is no memory');
});
