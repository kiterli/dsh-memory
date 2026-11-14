/**
 * hrr.js - deterministic Holographic Reduced Representation (HRR / VSA) layer
 * for dsh-memory.
 *
 * Conventions (documented once, relied on everywhere):
 *
 *  - Dimension: DEFAULT_DIM = 1024, matching the Hermes reference store's
 *    meta.hrr_dim = 1024 and its 1024 little-endian float32 hrr_vector payload
 *    (magic 'HRR1'). Any positive integer dim is supported; bind/unbind use a
 *    radix-2 FFT when dim is a power of two and a direct O(dim^2) loop otherwise.
 *  - Storage: every public vector is a Float32Array. Sums and norms are
 *    accumulated in Float64Array internally, so the float32 result is a
 *    deterministic rounding of deterministic double arithmetic.
 *  - Normalisation: every vector returned by encode()/bundle() has unit L2 norm
 *    (sum of squares == 1 up to float32 rounding), so similarity() is a true
 *    cosine in [-1, 1]. bind()/unbind() are NOT renormalised.
 *  - encode(text): hash-seeded random indexing. The text is tokenised (below);
 *    each token maps to a deterministic pseudo-random unit vector derived from
 *    FNV-1a-32(token, seed) driving a mulberry32 PRNG. encode() is the L2
 *    normalised bundle (superposition) of the DISTINCT token vectors, i.e.
 *    presence weighting: a token repeated in one text contributes once, so
 *    encode('gpu gpu') and encode('gpu') are identical. This is the standard
 *    random-indexing (set) convention and stops a repeated function word in a
 *    long text from dominating a short query. It needs no corpus statistics;
 *    inverse-document-frequency weighting would require the index, not encode.
 *  - Empty / whitespace-only text tokenises to zero tokens and yields the
 *    deterministic unit vector of the empty token (hash of ''), i.e. a defined,
 *    finite, unit-norm vector that is the same for '' and '   \n\t '.
 *  - bind(a, b): circular convolution   c[k] = sum_i a[i] * b[(k - i) mod n].
 *  - unbind(a, b): circular correlation r[i] = sum_j a[j] * b[(j - i) mod n],
 *    so unbind(bind(x, b), b) approximates x because random unit vectors are
 *    near-orthogonal (expected |cos| ~ 1/sqrt(dim)).
 *  - bundle(list): L2 normalised superposition (sum). A single vector is
 *    returned unchanged (it is already unit norm); an empty list returns a
 *    zero-length Float32Array; a cancelling sum (norm 0) returns all zeros.
 *  - Determinism: no Math.random, no Date, no environment input. The only
 *    floating point transcendentals are Math.cos/Math.sin inside the FFT used by
 *    bind/unbind; encode, similarity, bundle and index search use only + - * /.
 *  - Tokenisation: CJK ideographs, kana and hangul syllables are each emitted as
 *    a single-character token; runs of Unicode letters/digits are lower-cased and
 *    emitted as one token; everything else is a token boundary.
 *
 * Plain ESM, zero dependencies. ASCII-only source.
 */

export const MAGIC = 'HRR1';
export const DEFAULT_DIM = 1024;

/** Default PRNG seed (0x5eed) used by encode/bind-free helpers and createIndex. */
const DEFAULT_SEED = 0x5eed;

/* ------------------------------------------------------------------ *
 * Deterministic hashing and PRNG
 * ------------------------------------------------------------------ */

/** FNV-1a 32-bit over UTF-16 code units, with a final avalanche mix. */
function hash32(str, seed) {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: 32-bit integer state, uniformly distributed doubles in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Tokenisation (Latin runs + per-character CJK)
 * ------------------------------------------------------------------ */

const WORD_RE = /[\p{L}\p{N}]/u;

function isCjkCodePoint(cp) {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0x3040 && cp <= 0x309f) || // hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // katakana
    (cp >= 0xac00 && cp <= 0xd7af) || // hangul syllables
    (cp >= 0x20000 && cp <= 0x2fa1f) // CJK ext B+ (astral)
  );
}

/**
 * Split text into tokens. Each CJK character is its own token; runs of other
 * Unicode letters/digits are lower-cased and emitted whole; anything else
 * (including punctuation and whitespace) separates tokens.
 */
function tokenize(text) {
  const tokens = [];
  const src = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
  let buf = '';
  for (const ch of src) {
    const cp = ch.codePointAt(0);
    if (isCjkCodePoint(cp)) {
      if (buf !== '') {
        tokens.push(buf);
        buf = '';
      }
      tokens.push(ch);
    } else if (WORD_RE.test(ch)) {
      buf += ch.toLowerCase();
    } else if (buf !== '') {
      tokens.push(buf);
      buf = '';
    }
  }
  if (buf !== '') tokens.push(buf);
  return tokens;
}

/* ------------------------------------------------------------------ *
 * Atomic token vectors (cached)
 * ------------------------------------------------------------------ */

/** Token vector cache. Bounded: cleared wholesale when it grows too large. */
const CACHE_LIMIT = 4096;
const tokenCache = new Map();

function tokenVector(token, dim, seed) {
  const key = dim + ':' + seed + ':' + token;
  const hit = tokenCache.get(key);
  if (hit !== undefined) return hit;
  const rnd = mulberry32(hash32(token, seed));
  const acc = new Float64Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const v = rnd() * 2 - 1;
    acc[i] = v;
    norm += v * v;
  }
  const out = new Float32Array(dim);
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) out[i] = acc[i] * inv;
  } else {
    out[0] = 1; // unreachable for dim > 0; keeps the result defined
  }
  if (tokenCache.size >= CACHE_LIMIT) tokenCache.clear();
  tokenCache.set(key, out);
  return out;
}

/* ------------------------------------------------------------------ *
 * Option validation
 * ------------------------------------------------------------------ */

function resolveDim(value) {
  if (value === undefined || value === null) return DEFAULT_DIM;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('hrr: dim must be a positive integer');
  }
  return value;
}

/** Seeds are 32-bit unsigned. */
function resolveSeed(value) {
  if (value === undefined || value === null) return DEFAULT_SEED;
  if (!Number.isFinite(value)) throw new TypeError('hrr: seed must be a finite number');
  return value >>> 0;
}

function toVector(value, what) {
  if (value instanceof Float32Array) return value;
  if (value && typeof value.length === 'number' && Number.isInteger(value.length)) {
    return Float32Array.from(value);
  }
  throw new TypeError('hrr: ' + what + ' must be an array of numbers');
}

/* ------------------------------------------------------------------ *
 * encode
 * ------------------------------------------------------------------ */

/**
 * Encode text as a unit-L2-norm Float32Array of length opts.dim
 * (default DEFAULT_DIM) using opts.seed (default 0x5eed).
 *
 * Presence weighting: each distinct token contributes once, so the result
 * depends only on the *set* of tokens (order and repetition are ignored).
 */
export function encode(text, opts = {}) {
  const dim = resolveDim(opts.dim);
  const seed = resolveSeed(opts.seed);
  const tokens = tokenize(text);
  if (tokens.length === 0) return tokenVector('', dim, seed);
  const acc = new Float64Array(dim);
  const seen = new Set();
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (seen.has(token)) continue;
    seen.add(token);
    const v = tokenVector(token, dim, seed);
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += acc[i] * acc[i];
  const out = new Float32Array(dim);
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) out[i] = acc[i] * inv;
  } else {
    out[0] = 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * bind / unbind (circular convolution / correlation)
 * ------------------------------------------------------------------ */

function isPow2(n) {
  return n >= 2 && (n & (n - 1)) === 0;
}

/** In-place iterative radix-2 FFT over Float64Array re/im pairs. */
function fftPow2(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const p = i + k;
        const q = p + half;
        const ur = re[p];
        const ui = im[p];
        const vr = re[q] * cr - im[q] * ci;
        const vi = re[q] * ci + im[q] * cr;
        re[p] = ur + vr;
        im[p] = ui + vi;
        re[q] = ur - vr;
        im[q] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Circular convolution (conjugate=false) or circular correlation
 * (conjugate=true) of two equal-length real vectors.
 */
function circularCombine(a, b, conjugate) {
  const n = a.length;
  const out = new Float32Array(n);
  if (isPow2(n) && n >= 8) {
    const ar = Float64Array.from(a);
    const ai = new Float64Array(n);
    const br = Float64Array.from(b);
    const bi = new Float64Array(n);
    fftPow2(ar, ai, false);
    fftPow2(br, bi, false);
    for (let i = 0; i < n; i++) {
      const x = conjugate
        ? ar[i] * br[i] + ai[i] * bi[i]
        : ar[i] * br[i] - ai[i] * bi[i];
      const y = conjugate
        ? ai[i] * br[i] - ar[i] * bi[i]
        : ar[i] * bi[i] + ai[i] * br[i];
      ar[i] = x;
      ai[i] = y;
    }
    fftPow2(ar, ai, true);
    for (let i = 0; i < n; i++) out[i] = ar[i];
    return out;
  }
  if (!conjugate) {
    // c[k] = sum_i a[i] * b[(k - i) mod n]
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        let j = k - i;
        if (j < 0) j += n;
        sum += a[i] * b[j];
      }
      out[k] = sum;
    }
  } else {
    // r[i] = sum_j a[j] * b[(j - i) mod n]
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        let t = j - i;
        if (t < 0) t += n;
        sum += a[j] * b[t];
      }
      out[i] = sum;
    }
  }
  return out;
}

/** Circular convolution: bind(a, b)[k] = sum_i a[i] * b[(k - i) mod n]. */
export function bind(a, b) {
  const va = toVector(a, 'bind a');
  const vb = toVector(b, 'bind b');
  if (va.length !== vb.length) throw new TypeError('hrr: bind needs equal dimensions');
  if (va.length === 0) return new Float32Array(0);
  return circularCombine(va, vb, false);
}

/** Circular correlation: unbind(bind(x, b), b) approximates x. */
export function unbind(a, b) {
  const va = toVector(a, 'unbind a');
  const vb = toVector(b, 'unbind b');
  if (va.length !== vb.length) throw new TypeError('hrr: unbind needs equal dimensions');
  if (va.length === 0) return new Float32Array(0);
  return circularCombine(va, vb, true);
}

/* ------------------------------------------------------------------ *
 * bundle / similarity
 * ------------------------------------------------------------------ */

/**
 * L2-normalised superposition. A single element is returned as an exact copy
 * (it is assumed to be unit norm already); an empty list gives length 0.
 */
export function bundle(vectors) {
  const list = vectors === undefined || vectors === null ? [] : Array.from(vectors);
  if (list.length === 0) return new Float32Array(0);
  const first = toVector(list[0], 'bundle element');
  if (list.length === 1) return new Float32Array(first);
  const dim = first.length;
  const acc = new Float64Array(dim);
  for (let n = 0; n < list.length; n++) {
    const v = toVector(list[n], 'bundle element');
    if (v.length !== dim) throw new TypeError('hrr: bundle needs equal dimensions');
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += acc[i] * acc[i];
  const out = new Float32Array(dim);
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) out[i] = acc[i] * inv;
  }
  return out; // all zeros when the sum cancels exactly
}

/** Cosine similarity in [-1, 1]; 0 for a zero-norm vector. */
export function similarity(a, b) {
  const va = toVector(a, 'similarity a');
  const vb = toVector(b, 'similarity b');
  if (va.length !== vb.length) throw new TypeError('hrr: similarity needs equal dimensions');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i++) {
    const x = va[i];
    const y = vb[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!(na > 0) || !(nb > 0)) return 0;
  let c = dot / Math.sqrt(na * nb);
  if (!Number.isFinite(c)) return 0;
  if (c > 1) c = 1;
  else if (c < -1) c = -1;
  return c;
}

/* ------------------------------------------------------------------ *
 * Index
 * ------------------------------------------------------------------ */

/**
 * Private per-index state. Kept in a WeakMap so an Index exposes exactly the
 * documented surface (add/remove/has/vector/search/rebuild/size).
 */
const INDEX_STATE = new WeakMap();

/**
 * Create an in-memory holographic index.
 * opts: { dim = DEFAULT_DIM, seed = 0x5eed }
 */
export function createIndex(opts = {}) {
  const dim = resolveDim(opts.dim);
  const seed = resolveSeed(opts.seed);
  /** key (String(id)) -> { id, vec } */
  const entries = new Map();

  const index = {
    add(id, text) {
      entries.set(String(id), { id, vec: encode(text, { dim, seed }) });
    },
    remove(id) {
      return entries.delete(String(id));
    },
    has(id) {
      return entries.has(String(id));
    },
    vector(id) {
      const entry = entries.get(String(id));
      return entry ? new Float32Array(entry.vec) : null;
    },
    search(query, k = 10) {
      const limit = Number.isFinite(k) ? Math.max(0, Math.floor(k)) : 0;
      if (limit === 0 || entries.size === 0) return [];
      const qv = encode(query, { dim, seed });
      const scored = [];
      for (const entry of entries.values()) {
        scored.push({ id: entry.id, score: similarity(qv, entry.vec) });
      }
      // Array.prototype.sort is stable, so equal scores keep insertion order.
      scored.sort((x, y) => y.score - x.score);
      return scored.slice(0, limit);
    },
    rebuild(list) {
      entries.clear();
      const items = list === undefined || list === null ? [] : Array.from(list);
      for (const item of items) index.add(item.id, item.text);
    },
    get size() {
      return entries.size;
    },
  };

  INDEX_STATE.set(index, { dim, seed, entries });
  return index;
}

/** -> { magic, dim, seed, vectors: [[id, number[]], ...] } (exact float32 values). */
export function serializeIndex(index) {
  const state = INDEX_STATE.get(index);
  if (!state) throw new TypeError('hrr: serializeIndex expects an index from createIndex');
  const vectors = [];
  for (const entry of state.entries.values()) {
    vectors.push([entry.id, Array.from(entry.vec)]);
  }
  return { magic: MAGIC, dim: state.dim, seed: state.seed, vectors };
}

/** Rebuild an index from serializeIndex output (or its JSON round-trip). */
export function deserializeIndex(doc) {
  if (!doc || typeof doc !== 'object') {
    throw new TypeError('hrr: deserializeIndex expects an object');
  }
  if (doc.magic !== MAGIC) {
    throw new Error('hrr: deserializeIndex bad magic: ' + String(doc.magic));
  }
  const index = createIndex({ dim: doc.dim, seed: doc.seed });
  const state = INDEX_STATE.get(index);
  const vectors = Array.isArray(doc.vectors) ? doc.vectors : [];
  for (const pair of vectors) {
    if (!Array.isArray(pair) || pair.length < 2) {
      throw new TypeError('hrr: deserializeIndex expects [id, number[]] pairs');
    }
    state.entries.set(String(pair[0]), { id: pair[0], vec: Float32Array.from(pair[1]) });
  }
  return index;
}
