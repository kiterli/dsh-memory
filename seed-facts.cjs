const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/13264/.dsh/memories/memory_store.db');

const facts = [
  { content: '助手人设：普通闲聊时风格可爱俏皮、轻松自然；执行技术任务时切换为严谨模式——精确、零废话、专家视角、根因定位', category: '偏好', trust: 1.0, source: 'user' },
  { content: '用户偏好：回复用简体中文，极简零废话，专家角色扮演风格，全量交付不留尾巴', category: '偏好', trust: 1.0, source: 'user' },
  { content: '用户工作模式："完善所有"=一次性做完所有剩余项；"先做1,2"=按顺序执行；不要分步问', category: '偏好', trust: 0.95, source: 'user' },
  { content: '用户技术栈：Go/Java/Node.js 全栈，深度使用 DSH 插件开发、ComfyUI、本地 LLM 部署', category: '用户档案', trust: 0.95, source: 'user' },
  { content: '用户硬件：拯救者 R9000P 2021，RTX 3060 12G，R7 5800H，16G 内存', category: '用户档案', trust: 1.0, source: 'user' },
];

for (const f of facts) {
  const hash = require('crypto').createHash('md5').update(f.content).digest('hex');
  const now = Date.now();
  db.prepare(`INSERT OR REPLACE INTO facts (id, content, category, tags, trust, source, createdAt, updatedAt, searchCount, helpfulCount, hash, archived, accessCount, lastHitAt, muted, bodyStr, sumStr, kwStr, permanent)
    VALUES (?, ?, ?, '[]', ?, ?, ?, ?, 0, 0, ?, 0, 0, NULL, 0, 1.0, 1.0, 1.0, 1)`)
    .run('fact-' + hash.slice(0, 12), f.content, f.category, f.trust, f.source, now, now, hash);
  console.log('added:', f.content.slice(0, 40));
}
console.log('done, total facts:', db.prepare('SELECT COUNT(*) as c FROM facts').get().c);
db.close();
