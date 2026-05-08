/**
 * BM25 Search — pure JS 实现，无需外部服务
 * 
 * 使用已建立的 graph.bm25.idx 进行语义化搜索
 */

const fs = require('fs');
const path = require('path');

const IDX_FILE = path.join(__dirname, 'bm25', 'graph.bm25.idx');

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

let _cache = null;

function loadIndex() {
  if (_cache) return _cache;
  if (!fs.existsSync(IDX_FILE)) return null;
  try {
    _cache = JSON.parse(fs.readFileSync(IDX_FILE, 'utf8'));
    return _cache;
  } catch {
    return null;
  }
}

/**
 * BM25 评分计算
 */
function scoreBM25(idx, term, docId, docLen) {
  const inv = idx.inverted[term];
  if (!inv) return 0;

  const postings = inv.postings.filter(p => p.docId === docId);
  if (postings.length === 0) return 0;

  const tf = postings.length;
  const df = inv.df;
  const N = idx.docCount;
  const avgdl = idx.avgdl;
  const k1 = idx.k1;
  const b = idx.b;

  const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
  const tfScore = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl));

  return idf * tfScore;
}

/**
 * 搜索图谱
 * @param {string} query — 用户消息
 * @param {number} limit — 返回数量（默认5）
 * @returns {Array} — 排序后的实体列表 [{entity, score}]
 */
function search(query, { limit = 5 } = {}) {
  const idx = loadIndex();
  if (!idx) {
    console.error('BM25 index not found, run bm25_indexer.js first');
    return [];
  }

  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // 收集所有候选文档的分数
  const scores = {};
  const docLengths = {};

  for (const term of tokens) {
    const inv = idx.inverted[term];
    if (!inv) continue;

    // 遍历所有包含该 term 的文档
    for (const posting of inv.postings) {
      const { docId } = posting;
      if (!docLengths[docId]) {
        // 计算文档长度
        const docInfo = idx.docs[docId];
        if (docInfo) {
          const name = docInfo.name || '';
          const summary = docInfo.summary || '';
          docLengths[docId] = tokenize(name + ' ' + summary).length || 1;
        } else {
          docLengths[docId] = 1;
        }
      }

      if (!scores[docId]) scores[docId] = 0;
      scores[docId] += scoreBM25(idx, term, docId, docLengths[docId]);
    }
  }

  // 排序
  const sorted = Object.entries(scores)
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // 补全实体信息
  return sorted
    .filter(entry => entry.score > 0 && idx.docs[entry.docId])
    .map(entry => {
      const docInfo = idx.docs[entry.docId];
      return {
        id: entry.docId,
        type: docInfo.type,
        name: docInfo.name,
        role: docInfo.role,
        status: docInfo.status,
        code: docInfo.code,
        summary: docInfo.summary,
        score: Math.round(entry.score * 1000) / 1000
      };
    });
}

/**
 * 重建索引（当图谱更新时调用）
 */
function rebuildIndex() {
  const indexerPath = path.join(__dirname, 'bm25_indexer.js');
  if (fs.existsSync(indexerPath)) {
    const { execSync } = require('child_process');
    execSync(`node "${indexerPath}"`, { stdio: 'inherit' });
    _cache = null; // 清空缓存
  }
}

module.exports = { search, rebuildIndex, IDX_FILE };

// CLI 测试
if (require.main === module) {
  const query = process.argv.slice(2).join(' ');
  if (!query) {
    console.log('Usage: node bm25_search.js "your search query"');
    process.exit(0);
  }
  const results = search(query, { limit: 5 });
  console.log(`\nBM25 Search: "${query}"`);
  console.log(`Found ${results.length} results:\n`);
  results.forEach((r, i) => {
    console.log(`${i + 1}. [${r.type}] ${r.name} (score: ${r.score})`);
    if (r.summary) console.log(`   ${r.summary.slice(0, 80)}...`);
  });
}