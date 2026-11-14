const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/13264/.dsh/memories/memory_store.db', { readOnly: true });
const tables = ['facts','events','edges','feedbacks','entities'];
for (const t of tables) {
  try { console.log(t, db.prepare('SELECT COUNT(*) as c FROM '+t).get().c); } catch { console.log(t, 'N/A'); }
}
console.log('--- recent facts ---');
const recent = db.prepare('SELECT content, trust, category, source FROM facts ORDER BY createdAt DESC LIMIT 8').all();
for (const f of recent) console.log(`[${f.trust.toFixed(2)}] ${f.category}/${f.source}: ${f.content.slice(0,80)}`);
console.log('--- trust distribution ---');
console.log(db.prepare('SELECT CASE WHEN trust>=0.8 THEN "high" WHEN trust>=0.4 THEN "mid" ELSE "low" END as tier, COUNT(*) as c FROM facts GROUP BY tier').all());
db.close();
