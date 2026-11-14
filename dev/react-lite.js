// react-lite — a ~300-line React subset, dependency-free, used only by the standalone preview
// and the Node snapshot renderer. It is NOT shipped with the plugin: inside DSH the page runs on
// the host's real React (the loader's factory(require) receives it).
//
// Supported: createElement, useState, useEffect, useMemo, useRef, useCallback,
//            DOM mounting with in-place patching (so controlled inputs keep focus),
//            and an async HTML serializer for headless snapshots.
// Deliberately unsupported: class components, context, portals, keys-based reconciliation
// (children patch positionally), Suspense, error boundaries.
(function () {
  'use strict';

  // ------------------------------------------------------------------ vdom
  function flatten(value, out) {
    if (value === null || value === undefined || value === true || value === false) return;
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) flatten(value[i], out); return; }
    out.push(value);
  }
  function createElement(type, props) {
    const children = [];
    for (let i = 2; i < arguments.length; i++) flatten(arguments[i], children);
    return { type: type, props: props || {}, children: children };
  }
  function isFn(t) { return typeof t === 'function'; }

  // ------------------------------------------------------------------ hooks
  let current = null;
  let passInstances = [];
  let mode = 'dom';
  let dirty = false;

  function slot(kind) {
    const inst = current;
    if (!inst) throw new Error('hooks may only be called while rendering a component');
    const i = inst.index++;
    let s = inst.slots[i];
    if (!s || s.kind !== kind) { s = { kind: kind }; inst.slots[i] = s; }
    return s;
  }
  function sameDeps(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  function schedule() {
    dirty = true;
    if (mode === 'dom' && rootState && !scheduled) {
      scheduled = true;
      const run = function () { scheduled = false; doPass(); };
      if (typeof queueMicrotask === 'function') queueMicrotask(run); else setTimeout(run, 0);
    }
  }
  function useState(init) {
    const s = slot('state');
    if (!s.init) { s.init = true; s.v = (typeof init === 'function') ? init() : init; }
    return [s.v, function (next) {
      const v = (typeof next === 'function') ? next(s.v) : next;
      if (Object.is(v, s.v)) return;
      s.v = v;
      schedule();
    }];
  }
  function useEffect(fn, deps) {
    const s = slot('effect');
    const tracked = Array.isArray(deps);
    const changed = !s.init || !tracked || !sameDeps(s.deps, deps);
    s.init = true;
    s.fn = fn;
    s.deps = tracked ? deps.slice() : null;
    if (changed) {
      s.pending = true;
      if (current && current.pass.indexOf(s) < 0) current.pass.push(s);
    }
  }
  function useMemo(fn, deps) {
    const s = slot('memo');
    if (!s.init || !sameDeps(s.deps, deps)) { s.v = fn(); s.deps = Array.isArray(deps) ? deps.slice() : null; s.init = true; }
    return s.v;
  }
  function useRef(init) {
    const s = slot('ref');
    if (!s.init) { s.init = true; s.v = { current: init }; }
    return s.v;
  }
  function useCallback(fn, deps) { return useMemo(function () { return fn; }, deps); }

  function runComponent(inst) {
    inst.index = 0;
    inst.pass = [];
    passInstances.push(inst);
    const prev = current;
    current = inst;
    const vp = inst.vnode.props || {};
    let compProps = vp;
    // React hands a component its children on props.children (a single value, or an array for many).
    if (inst.vnode.children && inst.vnode.children.length) {
      compProps = {};
      for (const k in vp) compProps[k] = vp[k];
      compProps.children = inst.vnode.children.length === 1 ? inst.vnode.children[0] : inst.vnode.children;
    }
    let out;
    try {
      out = inst.vnode.type(compProps);
    } catch (err) {
      out = createElement('pre', { className: 'mm-render-error' }, String((err && err.message) || err));
    }
    current = prev;
    return out;
  }
  function runEffects() {
    const list = passInstances;
    passInstances = [];
    const queue = [];
    for (let i = 0; i < list.length; i++) {
      const inst = list[i];
      for (let j = 0; j < inst.pass.length; j++) { const s = inst.pass[j]; if (s.pending) queue.push(s); }
      inst.pass = [];
    }
    for (let i = 0; i < queue.length; i++) {
      const s = queue[i];
      s.pending = false;
      if (typeof s.cleanup === 'function') { try { s.cleanup(); } catch (e) { /* noop */ } }
      s.cleanup = null;
      try {
        const c = s.fn();
        if (typeof c === 'function') s.cleanup = c;
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) console.error('[react-lite] effect failed:', e);
      }
    }
  }

  // -------------------------------------------------------------- DOM renderer
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ATTR = {
    className: 'class', htmlFor: 'for', strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap',
    strokeLinejoin: 'stroke-linejoin', strokeDasharray: 'stroke-dasharray', fillOpacity: 'fill-opacity',
    strokeOpacity: 'stroke-opacity', tabIndex: 'tabindex',
  };
  const EVENTS = { onClick: ['click'], onChange: ['input', 'change'], onKeyDown: ['keydown'], onSubmit: ['submit'], onInput: ['input'] };
  const PROPS_AS_PROPERTY = { value: 1, checked: 1, selected: 1 };

  // Unitless style properties, mirroring React's behaviour for numeric values.
  const UNITLESS = { lineHeight: 1, fontWeight: 1, opacity: 1, zIndex: 1, flex: 1, flexGrow: 1, flexShrink: 1, order: 1, zoom: 1 };
  function styleToCss(style) {
    if (!style || typeof style !== 'object') return '';
    let out = '';
    for (const k in style) {
      if (style[k] === null || style[k] === undefined) continue;
      const name = k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); });
      const v = (typeof style[k] === 'number' && style[k] !== 0 && !UNITLESS[k]) ? style[k] + 'px' : style[k];
      out += name + ':' + v + ';';
    }
    return out;
  }
  function applyProps(node, prev, next, isSvg) {
    const seen = {};
    for (const k in prev) seen[k] = 1;
    for (const k in next) seen[k] = 1;
    for (const k in seen) {
      if (k === 'children' || k === 'key' || k === 'ref' || k === 'dangerouslySetInnerHTML') continue;
      const pv = prev[k], nv = next[k];
      if (nv === pv) continue;
      if (k === 'style') { node.removeAttribute('style'); const css = styleToCss(nv); if (css) node.setAttribute('style', css); continue; }
      if (PROPS_AS_PROPERTY[k]) { try { node[k] = nv === null || nv === undefined ? '' : nv; } catch (e) { /* noop */ } continue; }
      if (typeof nv === 'function' && EVENTS[k]) { setHandler(node, k, nv); continue; }
      const name = ATTR[k] || k;
      if (nv === null || nv === undefined || nv === false) { node.removeAttribute(name); continue; }
      if (nv === true) { node.setAttribute(name, ''); continue; }
      node.setAttribute(name, String(nv));
    }
  }
  function setHandler(node, key, fn) {
    const store = node.__rlHandlers || (node.__rlHandlers = {});
    if (!store[key]) {
      const listener = function (e) { const h = node.__rlHandlers[key]; if (typeof h === 'function') h(e); };
      const types = EVENTS[key];
      for (let i = 0; i < types.length; i++) node.addEventListener(types[i], listener);
    }
    store[key] = fn;
  }
  function isText(v) { return typeof v === 'string' || typeof v === 'number'; }
  // Two children may be patched in place only when they are both text or both the same element type.
  function sameNodeKind(a, b) {
    if (isText(a) || isText(b)) return isText(a) && isText(b);
    return a && b && a.type === b.type;
  }
  function createDom(v, inSvg) {
    // React ignores null/true/false children, but a placeholder node keeps the invariant that
    // childNodes[i] belongs to children[i] (patchDom relies on it).
    if (v === null || v === undefined || v === true || v === false) return document.createComment('');
    if (isText(v)) return document.createTextNode(String(v));
    if (isFn(v.type)) {
      const inst = v.__inst || { slots: [], index: 0, pass: [], out: null };
      v.__inst = inst;
      inst.vnode = v;
      const out = runComponent(inst);
      inst.out = out;
      const d = createDom(out, inSvg);
      v.__dom = d;
      return d;
    }
    if (typeof v.type !== 'string') { const c = document.createComment(' '); v.__dom = c; return c; }
    const isSvg = inSvg || v.type === 'svg';
    const node = isSvg ? document.createElementNS(SVG_NS, v.type) : document.createElement(v.type);
    applyProps(node, {}, v.props || {}, isSvg);
    for (let i = 0; i < v.children.length; i++) node.appendChild(createDom(v.children[i], isSvg));
    v.__dom = node;
    return node;
  }
  function patchDom(parent, next, prev, dom, inSvg) {
    const nextEmpty = next === null || next === undefined || next === true || next === false;
    const prevEmpty = prev === null || prev === undefined || prev === true || prev === false;
    // createDom installs a placeholder comment for an empty child so that childNodes[i] always
    // belongs to children[i]. patchDom must uphold the same invariant: removing the node here
    // would shift every later index, and the reconciler would then patch a text node as if it
    // were the element it expected. So an empty child keeps a placeholder in place.
    if (nextEmpty) {
      if (!dom) { const c = document.createComment(''); parent.appendChild(c); return c; }
      if (dom.nodeType === 8) return dom;
      const c = document.createComment('');
      parent.replaceChild(c, dom);
      return c;
    }
    if (prevEmpty || !dom || dom.nodeType === 3 || dom.nodeType === 8 || typeof dom.appendChild !== 'function') {
      const d = createDom(next, inSvg);
      if (!dom || typeof dom.parentNode === 'undefined') parent.appendChild(d);
      else parent.replaceChild(d, dom);
      return d;
    }
    const nt = isText(next);
    const pt = isText(prev);
    if (nt || pt) {
      if (nt && pt) { if (String(next) !== String(prev)) dom.nodeValue = String(next); return dom; }
      const d = createDom(next, inSvg);
      parent.replaceChild(d, dom);
      return d;
    }
    if (next.type !== prev.type) {
      const d = createDom(next, inSvg);
      parent.replaceChild(d, dom);
      return d;
    }
    if (isFn(next.type)) {
      const inst = prev.__inst || { slots: [], index: 0, pass: [], out: null };
      next.__inst = inst;
      inst.vnode = next;
      const old = inst.out;
      const out = runComponent(inst);
      inst.out = out;
      const d = patchDom(parent, out, old, dom, inSvg);
      next.__dom = d;
      return d;
    }
    const isSvg = inSvg || next.type === 'svg';
    applyProps(dom, prev.props || {}, next.props || {}, isSvg);
    const pk = prev.children || [], nk = next.children || [];
    // Patch the shared prefix in place, then rebuild the tail. Every vnode child owns exactly one
    // DOM node, so childNodes[i] is the node for children[i].
    let k = 0;
    while (k < pk.length && k < nk.length && sameNodeKind(pk[k], nk[k])) k++;
    for (let i = 0; i < k; i++) patchDom(dom, nk[i], pk[i], dom.childNodes[i], isSvg);
    for (let i = dom.childNodes.length - 1; i >= k; i--) dom.removeChild(dom.childNodes[i]);
    for (let i = k; i < nk.length; i++) dom.appendChild(createDom(nk[i], isSvg));
    next.__dom = dom;
    return dom;
  }

  let rootState = null;
  let scheduled = false;
  function doPass() {
    if (!rootState) return;
    const dom = patchDom(rootState.container, rootState.vnode, rootState.vnode, rootState.dom, false);
    rootState.dom = dom;
    runEffects();
  }
  function mount(vnode, container) {
    if (!container) throw new Error('mount(vnode, container) needs a container element');
    mode = 'dom';
    rootState = { vnode: vnode, container: container, dom: null };
    if (typeof container.__reactLiteDispose === 'function') { try { container.__reactLiteDispose(); } catch (e) { /* noop */ } }
    container.__reactLiteDispose = function () { rootState = null; };
    doPass();
    return {
      unmount: function () { if (rootState) { rootState.container.innerHTML = ''; rootState = null; } },
    };
  }

  // ----------------------------------------------------------- HTML serializer
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const VOID_TAGS = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1, path: 1, circle: 1, rect: 1, line: 1, polyline: 1, polygon: 1, use: 1, stop: 1 };
  function selectSelection(html, value) {
    // Mark the matching <option> as selected so the snapshot shows the real control state.
    const needle = 'value="' + esc(value) + '"';
    const at = html.indexOf(needle);
    if (at < 0) return html;
    return html.slice(0, at) + needle + ' selected' + html.slice(at + needle.length);
  }
  function nodeToHtml(v, inSvg) {
    if (v === null || v === undefined || v === true || v === false) return '';
    if (typeof v === 'string' || typeof v === 'number') return esc(String(v));
    if (isFn(v.type)) {
      const inst = v.__inst || { slots: [], index: 0, pass: [], out: null };
      v.__inst = inst;
      inst.vnode = v;
      const out = runComponent(inst);
      inst.out = out;
      return nodeToHtml(out, inSvg);
    }
    if (typeof v.type !== 'string') return '';
    const isSvg = inSvg || v.type === 'svg';
    const p = v.props || {};
    let attrs = '';
    for (const k in p) {
      if (k === 'children' || k === 'key' || k === 'dangerouslySetInnerHTML') continue;
      if (typeof p[k] === 'function' && EVENTS[k]) continue;
      if (k === 'style') { const css = styleToCss(p[k]); if (css) attrs += ' style="' + esc(css) + '"'; continue; }
      const val = p[k];
      if (val === null || val === undefined || val === false) continue;
      const name = ATTR[k] || k;
      attrs += ' ' + name + (val === true ? '' : '="' + esc(String(val)) + '"');
    }
    let kids = '';
    for (let i = 0; i < (v.children || []).length; i++) kids += nodeToHtml(v.children[i], isSvg);
    if (v.type === 'select' && p.value !== undefined && p.value !== null) kids = selectSelection(kids, p.value);
    if (VOID_TAGS[v.type] && kids === '') return '<' + v.type + attrs + '>';
    return '<' + v.type + attrs + '>' + kids + '</' + v.type + '>';
  }
  function sleepSync(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function toHtmlAsync(vnode, options) {
    const opts = options || {};
    mode = 'html';
    let html = '';
    for (let i = 0; i < 40; i++) {
      dirty = false;
      passInstances = [];
      html = nodeToHtml(vnode, false);
      runEffects();
      await sleepSync(opts.settleMs === undefined ? 5 : opts.settleMs);
      if (!dirty) break;
    }
    mode = 'dom';
    return html;
  }

  const ReactLite = {
    createElement: createElement,
    useState: useState,
    useEffect: useEffect,
    useMemo: useMemo,
    useRef: useRef,
    useCallback: useCallback,
    mount: mount,
    toHtmlAsync: toHtmlAsync,
    version: 'react-lite-1',
  };
  if (typeof window !== 'undefined') window.__ReactLite = ReactLite;
  if (typeof globalThis !== 'undefined') globalThis.__ReactLite = ReactLite;
})();
