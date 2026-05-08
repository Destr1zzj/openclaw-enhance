/**
 * StreamingContextScrubber — 流式隐私过滤器
 * 
 * 仿 Hermes agent/memory_manager.py 里的 StreamingContextScrubber
 * 用于在流式输出时，防止 <memory-context> 标签内的内容泄漏到 UI
 * 
 * 工作原理：
 * - 检测 <memory-context> 标签的开闭
 * - 在标签打开前，把内容暂存（hold）
 * - 标签关闭后，丢弃其中内容
 * - 处理流式 chunk 边界上的标签截断情况
 */

class StreamingContextScrubber {
  constructor() {
    // 状态机状态：'idle' | 'in-block'
    this._state = 'idle';
    // 暂存未关闭标签的内容
    this._hold = '';
    // 标签内缓冲区（已确认在 block 内的内容）
    this._buffer = '';
  }

  /**
   * 处理一段增量文本
   * @param {string} delta — 输入文本片段
   * @returns {string} — 过滤后可以输出的文本
   */
  feed(delta) {
    let output = '';

    for (let i = 0; i < delta.length; i++) {
      const ch = delta[i];

      if (this._state === 'idle') {
        // 检查标签开始
        if (ch === '<') {
          // 预读：检查是否是 <memory-context>
          const rest = delta.slice(i, i + 17);
          if (rest === '<memory-context>' || rest === '<Memory-Context>') {
            this._state = 'in-block';
            this._hold = '';
            i += 16; // 跳过 '<memory-context>'
            continue;
          }
          // 检查是否是 </memory-context>
          if (rest.slice(0, 2) === '</') {
            const rest2 = delta.slice(i + 2, i + 19);
            if (rest2 === 'memory-context>' || rest2 === 'Memory-Context>') {
              this._state = 'idle';
              this._buffer = '';
              i += 18;
              continue;
            }
          }
          // 普通字符，输出
          output += ch;
        } else {
          output += ch;
        }
      } else {
        // 在 block 内，积累但不输出
        this._buffer += ch;
        if (this._buffer.endsWith('</memory-context>') || this._buffer.endsWith('</Memory-Context>')) {
          this._state = 'idle';
          this._buffer = '';
        }
      }
    }

    return output;
  }

  /**
   * 流结束时调用，处理末尾可能未关闭的标签
   * @returns {string} — 最后的可见输出
   */
  flush() {
    if (this._state === 'in-block') {
      // 标签未关闭，丢弃 hold 的内容
      this._state = 'idle';
      this._hold = '';
      this._buffer = '';
    }
    return '';
  }
}

// ---------------------------------------------------------------------------
// GraphOperations — JSONL 图谱读写操作
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const GRAPH_FILE = path.join(__dirname, 'graph.jsonl');

function loadGraphLines() {
  if (!fs.existsSync(GRAPH_FILE)) return [];
  return fs.readFileSync(GRAPH_FILE, 'utf8').trim().split('\n').filter(Boolean);
}

/**
 * 全量读取图谱，返回最后一个有效实体的 updated 时间
 */
function getGraphStats() {
  const lines = loadGraphLines();
  let lastUpdated = null;
  let count = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.op === 'delete') { count--; continue; }
      count++;
      const entity = parsed.entity || parsed;
      const updated = entity.updated || entity.created;
      if (updated) lastUpdated = updated;
    } catch (e) { /* skip */ }
  }
  return { count: Math.max(0, count), lastUpdated };
}

/**
 * 全文搜索图谱
 */
function searchGraph(query, { limit = 10, types = null } = {}) {
  const lines = loadGraphLines();
  const results = [];
  const q = query.toLowerCase();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.op === 'delete') continue;
      const entity = parsed.entity || parsed;
      if (types && entity.type && !types.includes(entity.type)) continue;
      const text = JSON.stringify(entity).toLowerCase();
      if (text.includes(q)) {
        results.push(entity);
      }
      if (results.length >= limit) break;
    } catch (e) { /* skip */ }
  }
  return results;
}

/**
 * 根据 ID 查询单个实体
 */
function getEntityById(id) {
  const lines = loadGraphLines();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.op === 'delete') continue;
      const entity = parsed.entity || parsed;
      if (entity.id === id) return entity;
    } catch (e) { /* skip */ }
  }
  return null;
}

/**
 * 追加记录（create / update / delete）
 */
function appendRecord(record) {
  fs.appendFileSync(GRAPH_FILE, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * 软删除：追加一条 delete op
 */
function deleteEntity(id, reason = '') {
  appendRecord({
    op: 'delete',
    entity_id: id,
    reason,
    deleted: new Date().toISOString()
  });
}

/**
 * 汇总实体为可读摘要
 */
function summarizeEntity(entity) {
  if (!entity || !entity.properties) return '';
  const p = entity.properties;
  const parts = [];
  if (p.name) parts.push(p.name);
  if (p.purpose) parts.push(p.purpose);
  if (p.version) parts.push(`v${p.version}`);
  if (p.status) parts.push(`[${p.status}]`);
  if (p.summary) parts.push(p.summary);
  if (p.code) parts.push(`(${p.code})`);
  return parts.join(' | ');
}

/**
 * 生成唯一 ID
 */
function generateId(prefix, date = new Date()) {
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const lines = loadGraphLines();
  let seq = 1;
  for (const line of lines) {
    try {
      const p = JSON.parse(line);
      if (p.entity && p.entity.id && p.entity.id.startsWith(`${prefix}_${dateStr}`)) seq++;
    } catch (e) { /* skip */ }
  }
  return `${prefix}_${dateStr}_${String(seq).padStart(3, '0')}`;
}

module.exports = {
  StreamingContextScrubber,
  GraphOperations: {
    loadGraphLines,
    getGraphStats,
    searchGraph,
    getEntityById,
    appendRecord,
    deleteEntity,
    summarizeEntity,
    generateId,
    GRAPH_FILE
  }
};
