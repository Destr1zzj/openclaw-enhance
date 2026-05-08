/**
 * ontology-bootstrap hook handler
 * Triggered on: agent:bootstrap
 * 
 * 在每个会话开始时，将知识图谱内容以摘要形式注入到 SOUL.md 前面。
 * 使用 BM25 index 的 stats 来获取图谱概览。
 */

const fs = require('fs');
const path = require('path');

const IDX_FILE = path.join(__dirname, '../../workspace/memory/ontology/bm25/graph.bm25.idx');
const GRAPH_FILE = path.join(__dirname, '../../workspace/memory/ontology/graph.jsonl');

function loadGraphLines() {
  if (!fs.existsSync(GRAPH_FILE)) return [];
  const raw = fs.readFileSync(GRAPH_FILE, 'utf8').trim();
  return raw ? raw.split('\n').filter(Boolean) : [];
}

const handler = async (event) => {
  const workspaceDir = event.context && event.context.workspaceDir;
  if (!workspaceDir) return;

  // 加载实体（直接从 graph.jsonl，用于展示）
  let entities = [];
  try {
    const lines = loadGraphLines();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.op === 'delete') continue;
        const entity = parsed.entity || parsed;
        entities.push(entity);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (entities.length === 0) return;

  // 构建摘要
  const count = entities.length;
  let lastUpdated = null;
  for (const e of entities) {
    const u = e.updated || e.created;
    if (u && (!lastUpdated || u > lastUpdated)) lastUpdated = u;
  }

  // 每个实体一行摘要
  const lines = entities.slice(0, 20).map(e => {
    const p = e.properties || {};
    let name = p.name || p.title || p.code || e.id;
    if (p.role) name += ` (${p.role})`;
    if (p.status) name = `[${p.status}] ${name}`;
    if (p.code) name = `(${p.code}) ${name}`;
    return `• [${e.type || '?'}] ${name}`;
  });

  const header = `【知识图谱】${count}条实体 | 最近更新: ${lastUpdated || '无'}\n${lines.join('\n')}${count > 20 ? `\n…还有${count - 20}条` : ''}`;

  // 注入 SOUL.md
  const bootstrapFiles = event.context.bootstrapFiles;
  if (bootstrapFiles && Array.isArray(bootstrapFiles)) {
    const soulFile = bootstrapFiles.find(f => f.path && f.path.endsWith('SOUL.md'));
    if (soulFile && typeof soulFile.content === 'string') {
      soulFile.content = header + '\n\n---\n\n' + soulFile.content;
    }
  }
};

export default handler;