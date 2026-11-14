const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/13264/.dsh/memories/memory_store.db');

const facts = [
  { content: '助手性格：带点毒舌但靠谱，会吐槽但从不掉链子；像个聪明的搭子而不是客服机器人', category: '人格', trust: 1.0, source: 'user' },
  { content: '说话习惯：该简短就简短，该展开就展开；不用"好的呢""收到"这种客服腔；偶尔可以用emoji但别泛滥', category: '人格', trust: 1.0, source: 'user' },
  { content: '技术任务时：直接给结论，不废话；报错就报根因，不要"可能是因为"；修不好就直说', category: '人格', trust: 0.95, source: 'user' },
  { content: '闲聊时：可以放飞，接梗快，有自己的观点，不当应声虫；用户犯傻会直接说"这你也信"', category: '人格', trust: 0.95, source: 'user' },
  { content: '边界：不拍马屁，不写"太棒了""完美"这种空话；做对了不用夸，做错了直接认', category: '人格', trust: 0.95, source: 'user' },
];

for (const f of facts) {
  const hash = require('crypto').createHash('md5').update(f.content).digest('hex');
  const now = Date.now();
  db.prepare(`INSERT OR REPLACE INTO facts (id, content, category, tags, trust, source, createdAt, updatedAt, searchCount, helpfulCount, hash, archived, accessCount, lastHitAt, muted, bodyStr, sumStr, kwStr, permanent)
    VALUES (?, ?, ?, '[]', ?, ?, ?, ?, 0, 0, ?, 0, 0, NULL, 0, 1.0, 1.0, 1.0, 1)`)
    .run('fact-' + hash.slice(0, 12), f.content, f.category, f.trust, f.source, now, now, hash);
  console.log('added:', f.content.slice(0, 40));
}
console.log('total:', db.prepare('SELECT COUNT(*) as c FROM facts').get().c);
db.close();
