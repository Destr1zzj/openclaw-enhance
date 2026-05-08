/**
 * graph-to-pgvector sync script
 * 
 * 将 graph.jsonl 中的所有实体同步到 PostgreSQL pgvector 表
 * 1. 读取 graph.jsonl
 * 2. 对每个实体生成 MiniMax embedding
 * 3. upsert 到 knowledge_entities 表
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { embed } = require('./embed_client');

const GRAPH_FILE = path.join(__dirname, 'graph.jsonl');
const DB_CONFIG = {
  host: '127.0.0.1',
  port: 5432,
  database: 'openclaw',
  user: 'postgres',
  password: process.env.PG_PASSWORD || 'openclaw_pg_2026'
};

async function loadEntities() {
  if (!fs.existsSync(GRAPH_FILE)) return [];
  const raw = fs.readFileSync(GRAPH_FILE, 'utf8').trim();
  const lines = raw ? raw.split('\n') : [];
  const entities = [];
  for (const line of lines) {
    try {
      const p = JSON.parse(line);
      if (p.op === 'delete') continue;
      entities.push(p.entity || p);
    } catch { /* skip */ }
  }
  return entities;
}

function entityToText(e) {
  const p = e.properties || {};
  return [p.name, p.title, p.code, p.status, p.role, p.summary, p.description, e.type, e.id]
    .filter(Boolean).join(' ');
}

async function main() {
  const entities = await loadEntities();
  console.log(`Loaded ${entities.length} entities from graph.jsonl`);

  const client = new Client(DB_CONFIG);
  await client.connect();

  // 批量处理（避免 embedding 请求太大）
  const BATCH = 10;
  let totalIndexed = 0;

  for (let i = 0; i < entities.length; i += BATCH) {
    const batch = entities.slice(i, i + BATCH);
    const texts = batch.map(e => entityToText(e));

    console.log(`Embedding batch ${Math.floor(i/BATCH)+1}/${Math.ceil(entities.length/BATCH)} (${texts.length} texts)...`);
    let vectors;
    try {
      vectors = await embed(texts);
    } catch (err) {
      console.error(`Embedding failed: ${err.message}`);
      await client.end();
      process.exit(1);
    }

    // Upsert each entity
    for (let j = 0; j < batch.length; j++) {
      const e = batch[j];
      const v = vectors[j];
      const p = e.properties || {};
      const textContent = entityToText(e);

      await client.query(`
        INSERT INTO knowledge_entities (id, entity_type, properties, text_content, embedding, updated_at)
        VALUES ($1, $2, $3, $4, $5::vector, NOW())
        ON CONFLICT (id) DO UPDATE SET
          entity_type = EXCLUDED.entity_type,
          properties = EXCLUDED.properties,
          text_content = EXCLUDED.text_content,
          embedding = EXCLUDED.embedding,
          updated_at = NOW()
      `, [e.id, e.type || 'unknown', JSON.stringify(p), textContent, JSON.stringify(v)]);

      totalIndexed++;
    }
    console.log(`  Indexed ${totalIndexed}/${entities.length}`);
  }

  console.log(`\n✅ Done! ${totalIndexed} entities indexed to pgvector.`);
  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});