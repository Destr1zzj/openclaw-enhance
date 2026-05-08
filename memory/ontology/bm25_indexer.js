/**
 * BM25 Indexer — pure JSBM25 实现
 * 
 * 将 graph.jsonl 转为 BM25 索引文件（graph.bm25.idx）
 * 索引文件格式：JSON（term→docID→位置列表）+ docCount + avgdl
 */

const fs = require('fs');
const path = require('path');

const GRAPH_FILE = path.join(__dirname, 'graph.jsonl');
const IDX_FILE = path.join(__dirname, 'bm25', 'graph.bm25.idx');

const BM25_K1 = 1.5;
const BM25_B = 0.75;

// 停用词
const STOPWORDS = new Set([
  '的', '了', '是', '在', '有', '和', '就', '不', '人', '都', '一', '一个',
  '我', '你', '他', '她', '它', '们', '这', '那', '什么', '怎么', '为什么',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'what', 'how'
]);

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w.toLowerCase()));
}

function buildIndex() {
  if (!fs.existsSync(GRAPH_FILE)) {
    console.error('graph.jsonl not found');
    process.exit(1);
  }

  const raw = fs.readFileSync(GRAPH_FILE, 'utf8').trim();
  const lines = raw ? raw.split('\n') : [];
  const documents = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.op === 'delete') continue;
      const entity = parsed.entity || parsed;
      documents.push(entity);
    } catch { /* skip */ }
  }

  console.log(`Indexing ${documents.length} entities...`);

  // DocID → 文本内容
  const docTexts = {};
  // 倒排索引 term → [{docId, positions}]
  const invertedIndex = {};
  // 文档长度
  const docLengths = {};
  let totalLen = 0;

  for (const doc of documents) {
    const id = doc.id;
    // 用实体 properties 拼接成可搜索文本
    const p = doc.properties || {};
    const searchable = [
      p.name, p.title, p.code, p.status, p.role,
      p.purpose, p.summary, p.description,
      doc.type, id
    ].filter(Boolean).join(' ');

    const tokens = tokenize(searchable);
    docLengths[id] = tokens.length;
    docTexts[id] = { text: searchable, tokens, entity: doc };
    totalLen += tokens.length;

    // 倒排
    for (let i = 0; i < tokens.length; i++) {
      const term = tokens[i].toLowerCase();
      if (!invertedIndex[term]) invertedIndex[term] = [];
      invertedIndex[term].push({ docId: id, pos: i });
    }
  }

  const docCount = documents.length;
  const avgdl = docCount > 0 ? totalLen / docCount : 0;

  const idx = {
    version: '1.0',
    created: new Date().toISOString(),
    docCount,
    avgdl,
    k1: BM25_K1,
    b: BM25_B,
    // 倒排索引：term → [{docId, tf, positions}]
    inverted: {},
    // 文档摘要：docId → {type, name, summary}
    docs: {}
  };

  // 计算每个 term 的文档频率（df）
  for (const [term, postings] of Object.entries(invertedIndex)) {
    const uniqueDocs = new Set(postings.map(p => p.docId));
    idx.inverted[term] = {
      df: uniqueDocs.size,
      postings: postings
    };
    idx.docs[term] = null; // placeholder, filled below
  }

  // 保存 doc 摘要
  for (const doc of documents) {
    const p = doc.properties || {};
    idx.docs[doc.id] = {
      type: doc.type,
      name: p.name || p.title || p.code || doc.id,
      role: p.role,
      status: p.status,
      code: p.code,
      summary: p.summary || p.description || ''
    };
  }

  // 写入索引文件
  fs.mkdirSync(path.dirname(IDX_FILE), { recursive: true });
  fs.writeFileSync(IDX_FILE, JSON.stringify(idx), 'utf8');
  console.log(`BM25 index written to: ${IDX_FILE}`);
  console.log(`  docs: ${docCount}, terms: ${Object.keys(idx.inverted).length}, avgdl: ${avgdl.toFixed(2)}`);
}

buildIndex();