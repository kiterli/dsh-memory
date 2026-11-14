#!/usr/bin/env node
/**
 * tools/eval-recall.mjs — run a recall evaluation against the live memory store.
 *
 * Unlike every other check in this plugin, this one answers the question a user actually
 * cares about: does a real question find the right memory?
 *
 * Usage:
 *   node tools/eval-recall.mjs                          # auto-build a fixture from the store and run it
 *   node tools/eval-recall.mjs --fixture path.json      # run a saved fixture
 *   node tools/eval-recall.mjs --save path.json         # auto-build and save, do not run
 *   node tools/eval-recall.mjs --fixture f.json --k 3
 *
 * Why the output is per-kind and never one number: see the header of lib/eval.js. Literal
 * queries only prove substring matching works; the paraphrase rows are the measurement; the
 * unanswerable rows catch a retriever that simply never refuses.
 *
 * Exit code 1 when the verdict is "poor" or "over-eager", so this can gate a change.
 */
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { resolveMemoryConfig } from '../lib/config.js';
import { openStore } from '../lib/store.js';
import { recall } from '../lib/recall.js';
import * as hrr from '../lib/hrr.js';
import { createEmbedder } from '../lib/embed.js';
import {
  validateFixture,
  scoreQueries,
  buildFixture,
  DEFAULT_K,
} from '../lib/eval.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

function parseArgs(argv) {
  const args = { fixture: null, save: null, k: DEFAULT_K, limit: 8, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--save') args.save = argv[++i];
    else if (a === '--k') args.k = Number(argv[++i]) || DEFAULT_K;
    else if (a === '--limit') args.limit = Number(argv[++i]) || 8;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node tools/eval-recall.mjs [--fixture f.json] [--save f.json] [--k 5] [--limit 8]`);
    return 0;
  }

  const cfg = resolveMemoryConfig({});
  const store = await openStore(cfg, { logger: { info() {}, warn() {}, error() {} } });
  await store.init();

  // The evaluation must run against the SAME retrieval stack the agent uses, or it measures
  // a different system. An earlier version called recall() with no embedder and no HRR
  // index, so every paraphrase scored 0 — it was measuring the keyword channel alone and
  // calling that "the retriever".
  //
  // HRR is built ALWAYS: it is pure arithmetic on the fact text, needs no model, and costs
  // a few MB. Only the embedder (the ONNX model) is gated by DSH_MEMORY_NO_EMBED, because
  // that is the part that can exhaust this machine's RAM.
  let embedder = null;
  let embedderState = 'disabled (DSH_MEMORY_NO_EMBED=1)';
  let vectorCount = 0;

  let hrrIndex = null;
  try {
    hrrIndex = hrr.createIndex({ dim: hrr.DEFAULT_DIM });
    const rows = (await store.queryFacts({ q: '', limit: 5000 })).facts;
    hrrIndex.rebuild(rows.map((f) => ({ id: String(f.id), text: `${f.content ?? ''}` })));
  } catch {
    hrrIndex = null;
  }

  try {
    if (process.env.DSH_MEMORY_NO_EMBED !== '1') {
      embedder = createEmbedder({
        dbPath: cfg.storePath,
        cacheDir: path.join(os.homedir(), '.dsh', 'memory-models'),
        hfMirror: 'https://hf-mirror.com',
        logger: { info() {}, warn() {}, error() {} },
      });
      // Wait for the model to load; without this the first N queries silently fall back to
      // keyword+HRR and drag the score down for the wrong reason.
      for (let i = 0; i < 40 && !embedder.isReady() && !embedder.isFailed(); i += 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
      embedderState = embedder.isFailed() ? 'failed' : embedder.isReady() ? 'ready' : 'still loading';

      // The worker starts empty: vectors live in SQLite and must be loaded into it before
      // any search can return anything. Forgetting this made the semantic channel silently
      // contribute ZERO hits while still reporting "ready" — the worst kind of failure,
      // because the report looked like a real measurement.
      if (embedder.isReady()) {
        try {
          await embedder.loadVectors();
        } catch { /* the worker may already be loading them */ }
        // Give the worker a moment to finish loading before the first query.
        let loaded = 0;
        for (let i = 0; i < 20; i += 1) {
          loaded = Number(embedder.getVectorCount?.() ?? 0);
          if (loaded > 0) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        vectorCount = loaded;
        if (loaded === 0) embedderState = 'ready (but 0 vectors loaded)';
      }
    }
  } catch (error) {
    embedderState = `unavailable: ${error?.message ?? error}`;
  }

  try {
    const all = await store.queryFacts({ q: '', limit: 5000 });
    const facts = all?.facts ?? [];

    if (!args.quiet) {
      console.log(`store: ${cfg.home}`);
      console.log(`live facts: ${facts.length}`);
      console.log(`channels: keyword + ${embedderState}${vectorCount ? ` (${vectorCount} vectors)` : ''} + ${hrrIndex ? 'hrr' : 'no-hrr'}`);
    }

    if (facts.length === 0) {
      console.log('no facts to evaluate — record a few memories first');
      return 0;
    }

    // ---- load or build the fixture -------------------------------------------------
    let fixture;
    if (args.fixture) {
      const raw = JSON.parse(await readFile(path.resolve(args.fixture), 'utf8'));
      fixture = raw;
      if (!args.quiet) console.log(`fixture: ${args.fixture}`);
    } else {
      fixture = buildFixture(facts);
      if (!args.quiet) {
        console.log(`fixture: auto-built (${fixture.queries.length} queries)`);
        console.log('  note: literal rows only prove substring matching; paraphrase rows are the real measure');
      }
    }

    if (args.save) {
      const target = path.resolve(args.save);
      await writeFile(target, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
      console.log(`saved fixture -> ${target}`);
      if (!args.fixture) return 0;
    }

    // ---- validate ------------------------------------------------------------------
    const { ok, errors, queries } = validateFixture(fixture);
    if (!ok) {
      console.error('fixture is invalid:');
      for (const e of errors) console.error(`  - ${e}`);
      return 2;
    }

    // ---- run ----------------------------------------------------------------------
    const report = await scoreQueries(
      queries,
      async (q) => {
        const r = await recall({ store, query: q, limit: args.limit, embedder, hrrIndex });
        return { facts: r.facts, status: r.status };
      },
      { k: args.k },
    );

    printReport(report, { quiet: args.quiet });

    const failing = report.verdict === 'poor' || report.verdict === 'over-eager';
    return failing ? 1 : 0;
  } finally {
    try { await embedder?.dispose?.(); } catch { /* already gone */ }
    await store.close();
  }
}

function printReport(report, { quiet } = {}) {
  const { byKind, overall, verdict, k } = report;

  console.log('');
  console.log(`=== recall evaluation (k=${k}) ===`);

  for (const kind of ['literal', 'paraphrase', 'unanswerable']) {
    const row = byKind[kind];
    if (!row) { console.log(`  ${kind.padEnd(14)} (no queries)`); continue; }
    if (kind === 'unanswerable') {
      console.log(`  ${kind.padEnd(14)} n=${row.total}  refusal=${row.refusalRate}  softMiss=${row.softMisses}  confidentWrong=${row.confidentWrong}`);
    } else {
      console.log(`  ${kind.padEnd(14)} n=${row.total}  recall@${k}=${row[`recall@${k}`]}  mrr=${row.mrr}  notFound=${row.notFound}  late=${row.foundButLate}`);
    }
  }

  console.log(`  ${'answerable'.padEnd(14)} recall=${overall.answerableRecall}  errors=${overall.errors}`);
  console.log(`  VERDICT        ${verdict}`);

  if (!quiet) {
    const misses = report.rows.filter((r) => !r.hit && r.kind !== 'unanswerable');
    if (misses.length > 0) {
      console.log('');
      console.log('--- misses (the useful part) ---');
      for (const m of misses.slice(0, 15)) {
        const why = m.error ? `error: ${m.error}` : m.rank === null ? 'not found' : `rank ${m.rank} > ${k}`;
        console.log(`  [${m.kind}] ${m.q}`);
        console.log(`      ${why} (returned ${m.returned}, status ${m.status})`);
      }
    }
  }

  console.log('');
  console.log('note: literal recall only proves the keyword path works. Paraphrase recall is the');
  console.log('real measurement, and a high answerable score with a low refusal rate means the');
  console.log('retriever answers everything — which is unreliable, not good.');
}

main().then((code) => {
  process.exitCode = code ?? 0;
}).catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
