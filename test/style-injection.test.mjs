/**
 * Regression test for the DSH style-injection contract.
 *
 * The bug this guards against: the page rendered as unstyled HTML inside DSH because the
 * stylesheet was appended from apply(), long after the window dsh-client-modules observes.
 *
 * dsh-client-modules wraps its factory call as:
 *   const before = untaggedStyles();                       // style:not([data-plugin])
 *   exports = registered.factory(makeRequire(...));
 *   styles  = claimStyles(ownerId, before);                // stamp the new tags
 *
 * This test reproduces that window exactly: snapshot untagged styles, run the real
 * client.js factory, then assert the <style> tag appeared DURING the factory call and is
 * therefore claimable. It also asserts the inject declaration lists the services the
 * plugin actually reads, because an undeclared ctx.<service> read throws in DSH.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = readFileSync(join(root, 'client.js'), 'utf8');

/* --------------------------------------------------- minimal DOM for the factory */

function makeDom() {
  const created = [];
  const head = {
    tagName: 'HEAD',
    children: [],
    appendChild(node) { this.children.push(node); node.parentNode = this; created.push(node); return node; },
  };
  const document = {
    head,
    getElementById(id) { return created.find((n) => n.id === id) || null; },
    createElement(tag) {
      const el = { tagName: String(tag).toUpperCase(), id: '', textContent: '', nodeType: 1, attributes: {}, parentNode: null };
      el.setAttribute = (k, v) => { el.attributes[k] = v; if (k === 'id') el.id = v; };
      return el;
    },
  };
  return { document, head, created };
}

/** Load client.js the way a page would: capture __ModuleLoader__.load({id, factory}). */
function evaluateFactory(document) {
  const registrations = [];
  const sandbox = {
    document,
    window: null,
    navigator: { clipboard: null },
    console,
    setTimeout,
    clearTimeout,
    fetch: undefined,
    Promise,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
  };
  sandbox.window = sandbox;
  sandbox.window.__ModuleLoader__ = {
    load(entry) { registrations.push(entry); return entry; },
  };
  const ctxObj = vm.createContext(sandbox);
  vm.runInContext(source, ctxObj, { filename: 'client.js' });

  assert.equal(registrations.length, 1, 'exactly one module registration');
  const entry = registrations[0];
  assert.equal(entry.id, '@local/dsh-memory');

  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
  };

  // --- the dsh-client-modules window --------------------------------------
  const untagged = () => new Set([...document.head.children].filter((el) => el.tagName === 'STYLE' && !el.attributes['data-plugin']));
  const before = untagged();
  const plugin = entry.factory((name) => {
    if (name === 'react') return ReactStub;
    throw new Error('unexpected require: ' + name);
  });
  const after = untagged();
  const claimed = [...after].filter((el) => !before.has(el));

  return { plugin, claimed, before, after, document };
}

/* ------------------------------------------------------------------- tests */

test('the stylesheet is appended during factory evaluation, so DSH can claim it', () => {
  const dom = makeDom();
  const { claimed } = evaluateFactory(dom.document);

  assert.equal(claimed.length, 1, `expected exactly one claimable <style>, got ${claimed.length}`);
  const tag = claimed[0];
  assert.equal(tag.tagName, 'STYLE');
  assert.match(tag.textContent, /\.mm-view\{/, 'the real page CSS is inside the tag');
  assert.match(tag.textContent, /\.mm-panel-head\{/, 'layout classes present');
  assert.ok(tag.textContent.length > 5000, 'the full stylesheet, not a stub');
});

test('inject declares every host service the page reads, and style tags stay idempotent', () => {
  const dom = makeDom();
  const { plugin, document } = evaluateFactory(dom.document);

  assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots'],
    'inject must list slots (registrations) and locale (tt dictionaries); styles must NOT be declared');

  assert.equal(typeof plugin.apply, 'function');

  // apply() must not append a second, duplicate tag when the factory already did.
  const beforeCount = document.head.children.length;
  const services = {
    slots: {
      inject(name, fn) { fn(); return () => {}; },
      register() { return () => {}; },
    },
    locale: {
      register() { return () => {}; },
      bind() { return (k) => k; },
    },
  };
  const ctx = {
    get(name) { return services[name]; },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    on() {},
  };
  // Reading an undeclared service throws in DSH; emulate that so we prove the plugin
  // tolerates it rather than dying.
  const guarded = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'styles') throw new Error('service "styles" is not declared by your plugin');
      const v = target[prop];
      if (typeof v === 'function') return v.bind(target);
      return v;
    },
  });

  plugin.apply(guarded);
  assert.equal(document.head.children.length, beforeCount,
    'apply() must not append a second stylesheet (idempotent by CSS_ID)');
});
