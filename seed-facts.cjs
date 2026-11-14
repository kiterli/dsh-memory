/**
 * 把一组事实写入本地记忆库（开发/初始化辅助脚本）。
 *
 * 数据来源不再硬编码 —— 从 JSON 文件读取，方便自用但不把个人信息带进仓库：
 *   node seed-facts.cjs my-facts.json
 *
 * JSON 格式（数组）：
 *   [
 *     { "content": "…", "category": "偏好", "trust": 0.95, "source": "user" }
 *   ]
 *
 * 未传参数时，只写入下面这几条**示例**事实（不含任何真实个人信息），
 * 方便验证数据库写入链路是否正常。
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const dbPath = process.env.DSH_MEMORY_DB || path.join(DSH_HOME, 'memories', 'memory_store.db');

if (!fs.existsSync(dbPath)) {
  console.error(`找不到记忆库：${dbPath}`);
  console.error('插件跑过一次之后才会有这个文件。');
  process.exit(1);
}

/** 示例数据：仅用于验证写入链路，不含真实个人信息。 */
const SAMPLE_FACTS = [
  { content: '示例事实：这条数据用于验证 seed 写入是否正常', category: '示例', trust: 0.5, source: 'seed' },
  { content: '示例事实：可以随时用 memory_forget 删掉它', category: '示例', trust: 0.5, source: 'seed' },
];

const inputFile = process.argv[2];
let facts;

if (inputFile) {
  if (!fs.existsSync(inputFile)) {
    console.error(`找不到输入文件：${inputFile}`);
    process.exit(1);
  }
  try {
    facts = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (e) {
    console.error(`解析 JSON 失败：${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(facts)) {
    console.error('输入文件必须是数组。');
    process.exit(1);
  }
} else {
  facts = SAMPLE_FACTS;
  console.log('未指定输入文件，写入 2 条示例事实。');
  console.log('写入自己的数据：node seed-facts.cjs my-facts.json\n');
}

const db = new DatabaseSync(dbPath);

for (const f of facts) {
  if (!f || typeof f.content !== 'string' || !f.content.trim()) {
    console.warn('跳过一条无效记录（缺少 content）：', JSON.stringify(f).slice(0, 60));
    continue;
  }
  const hash = crypto.createHash('md5').update(f.content).digest('hex');
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO facts (id, content, category, tags, trust, source, createdAt, updatedAt, searchCount, helpfulCount, hash, archived, accessCount, lastHitAt, muted, bodyStr, sumStr, kwStr, permanent)
     VALUES (?, ?, ?, '[]', ?, ?, ?, ?, 0, 0, ?, 0, 0, NULL, 0, 1.0, 1.0, 1.0, 1)`,
  ).run(
    'fact-' + hash.slice(0, 12),
    f.content,
    f.category ?? '未分类',
    typeof f.trust === 'number' ? f.trust : 0.7,
    f.source ?? 'seed',
    now,
    now,
    hash,
  );
  console.log('added:', f.content.slice(0, 40));
}

console.log('done, total facts:', db.prepare('SELECT COUNT(*) as c FROM facts').get().c);
db.close();
