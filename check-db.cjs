/**
 * 检查本地记忆库的统计信息（开发辅助脚本）。
 *
 * 用法：
 *   node check-db.cjs
 *   DSH_HOME=/path/to/.dsh node check-db.cjs
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const dbPath = process.env.DSH_MEMORY_DB || path.join(DSH_HOME, 'memories', 'memory_store.db');

if (!fs.existsSync(dbPath)) {
  console.error(`找不到记忆库：${dbPath}`);
  console.error('插件跑过一次之后才会有这个文件。');
  console.error('如果 DSH 装在别处，用 DSH_HOME 指定：');
  console.error('  DSH_HOME=/path/to/.dsh node check-db.cjs');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
console.log(`库文件：${dbPath}\n`);

const tables = ['facts', 'events', 'edges', 'feedbacks', 'entities', 'fact_versions'];
for (const t of tables) {
  try {
    console.log(t, db.prepare('SELECT COUNT(*) as c FROM ' + t).get().c);
  } catch {
    console.log(t, 'N/A');
  }
}

console.log('\n--- recent facts ---');
try {
  const recent = db
    .prepare('SELECT content, trust, category, source FROM facts ORDER BY createdAt DESC LIMIT 8')
    .all();
  for (const f of recent) {
    console.log(`[${Number(f.trust).toFixed(2)}] ${f.category}/${f.source}: ${String(f.content).slice(0, 80)}`);
  }
} catch (e) {
  console.log('读取失败：', e.message);
}

console.log('\n--- trust distribution ---');
try {
  console.log(
    db
      .prepare(
        "SELECT CASE WHEN trust>=0.8 THEN 'high' WHEN trust>=0.4 THEN 'mid' ELSE 'low' END as tier, COUNT(*) as c FROM facts GROUP BY tier",
      )
      .all(),
  );
} catch (e) {
  console.log('统计失败：', e.message);
}

db.close();
