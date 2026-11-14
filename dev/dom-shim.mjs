// A ~90-line DOM stand-in, just enough for dev/react-lite.js's DOM mode (mount + patch) so the
// interactive path of the preview can be exercised without a browser. Not a general DOM: it
// implements only what react-lite calls. Used by test/client.contract.test.mjs.
function textOf(n) {
  if (!n) return '';
  if (n.nodeType === 3 || n.nodeType === 8) return n.nodeValue || '';
  if (n.__text !== undefined) return n.__text;
  let out = '';
  for (const c of n.childNodes) out += textOf(c);
  return out;
}

function createElement(tag, ns) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    localName: String(tag),
    namespaceURI: ns || null,
    attributes: {},
    style: {},
    childNodes: [],
    parentNode: null,
    __listeners: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'style') this.style = parseStyle(String(value));
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    insertBefore(child, ref) {
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      if (i < 0) this.childNodes.push(child); else this.childNodes.splice(i, 0, child);
      return child;
    },
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
      return child;
    },
    replaceChild(next, old) {
      const i = this.childNodes.indexOf(old);
      if (i < 0) return old;
      next.parentNode = this;
      old.parentNode = null;
      this.childNodes[i] = next;
      return old;
    },
    addEventListener(type, fn) { (this.__listeners[type] || (this.__listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      const a = this.__listeners[type];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    dispatch(type, event) {
      const a = (this.__listeners[type] || []).slice();
      for (const fn of a) fn(event || { type, target: this });
      return a.length;
    },
    get firstChild() { return this.childNodes[0] || null; },
    // Real DOM exposes className as a property over the class attribute; react-lite writes
    // attributes, and callers read the property, so the two have to be bridged here.
    get className() { return this.attributes.class || ''; },
    set className(v) { this.attributes.class = String(v); },
    get id() { return this.attributes.id || ''; },
    set id(v) { this.attributes.id = String(v); },
    get textContent() { return textOf(this); },
    set textContent(v) { this.childNodes = []; this.__text = String(v); },
    set innerHTML(v) { this.childNodes = []; this.__text = v === '' ? undefined : String(v); },
    get innerHTML() { return this.__text !== undefined ? this.__text : ''; },
  };
  return el;
}

function parseStyle(css) {
  const out = {};
  for (const part of String(css).split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createDocument() {
  const document = {
    createElement: (tag) => createElement(tag),
    createElementNS: (ns, tag) => createElement(tag, ns),
    createTextNode: (v) => ({ nodeType: 3, nodeValue: String(v), childNodes: [], parentNode: null, get textContent() { return this.nodeValue; } }),
    createComment: (v) => ({ nodeType: 8, nodeValue: String(v), childNodes: [], parentNode: null, get textContent() { return ''; } }),
    getElementById: () => null,
    head: createElement('head'),
    body: createElement('body'),
  };
  return document;
}

// Depth-first walk of every element under `root` (root included).
export function walk(root, out) {
  const acc = out || [];
  if (!root) return acc;
  acc.push(root);
  for (const c of root.childNodes || []) walk(c, acc);
  return acc;
}

export function findAll(root, pred) {
  return walk(root).filter((n) => n.nodeType === 1 && pred(n));
}

export function text(node) { return textOf(node); }

export { textOf };
