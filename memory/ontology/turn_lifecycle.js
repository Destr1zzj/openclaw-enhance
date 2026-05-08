/**
 * TurnLifecycle — 仿 Hermes 的 prefetch + sync 自动化
 * 
 * 第 4 步：prefetch/sync 自动化
 * 
 * prefetch:  每次用户消息到达时，基于内容自动搜索相关记忆，不依赖 LLM
 * sync:      回复后，分析是否有值得自动写入的重大事件/决策/偏好
 * 
 * 触发规则（符合以下任一条件则自动写入）：
 * - 安装了新的 skill
 * - 用户明确表达了偏好或事实
 * - 产生了新的决策或规则
 * - 项目状态发生变化
 * - 重要事件发生
 */

const {
  GraphOperations,
  StreamingContextScrubber
} = require('./graph_ops');

const {
  searchGraph,
  appendRecord,
  generateId,
  summarizeEntity
} = GraphOperations;

// ---------------------------------------------------------------------------
// 自动写入触发规则
// ---------------------------------------------------------------------------

/**
 * 关键词匹配规则：检测用户消息是否包含需要自动记忆的内容
 * 返回 { trigger: boolean, type: string, content: object } 或 null
 */
function detectAutoSave(userMessage, assistantResponse) {
  if (!userMessage || typeof userMessage !== 'string') return null;
  const lower = userMessage.toLowerCase();

  // 规则1：安装技能
  if (lower.includes('安装') && lower.includes('skill')) {
    const skillMatch = userMessage.match(/([^ \n]+(?:skill|Skill))[^\n]*/);
    return {
      trigger: true,
      type: 'Document',
      content: {
        note: '用户通过skillhub安装新技能',
        source: 'auto-detect',
        raw: userMessage.slice(0, 200)
      }
    };
  }

  // 规则2：明确偏好表达
  const preferencePatterns = [
    /喜欢|prefer|不喜欢|讨厌|want|想要|希望|希望我做|你帮我/i,
    /不要|别|不需要|avoid|不要做/i,
    /总是|从来不|每次都|i always|i never/i
  ];
  for (const pattern of preferencePatterns) {
    if (pattern.test(userMessage)) {
      return {
        trigger: true,
        type: 'Person',
        content: {
          note: '用户明确表达偏好或习惯',
          source: 'auto-detect',
          raw: userMessage.slice(0, 200)
        }
      };
    }
  }

  // 规则3：决策或规则确认
  if (lower.includes('确认') || lower.includes('决定') || lower.includes('好的') || lower.includes('就这样')) {
    if (assistantResponse && assistantResponse.length > 50) {
      return {
        trigger: true,
        type: 'Policy',
        content: {
          note: '用户确认了一个决策',
          source: 'auto-detect',
          raw: userMessage.slice(0, 200)
        }
      };
    }
  }

  // 规则4：更新进度
  if (lower.includes('完成') || lower.includes('结束') || lower.includes('结束了') || lower.includes('搞定了')) {
    return {
      trigger: true,
      type: 'Event',
      content: {
        note: '用户告知任务完成',
        source: 'auto-detect',
        raw: userMessage.slice(0, 200)
      }
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// TurnLifecycle — 核心类
// ---------------------------------------------------------------------------

class TurnLifecycle {
  constructor(provider) {
    this.provider = provider;
    this.scrubber = new StreamingContextScrubber();
    // 缓存上一轮的记忆，用于减少重复写入
    this._lastWritten = null;
  }

  /**
   * prefetch — 对话前自动搜索相关记忆
   * @param {string} userMessage — 用户原始消息
   * @param {object} context — 可选：会话上下文
   * @returns {Array} — 匹配的记忆实体列表
   */
  prefetch(userMessage, context = {}) {
    if (!userMessage || userMessage.trim().length < 3) return [];

    // 提取关键词（简单分词：取长度>2的词）
    const words = userMessage
      .replace(/[^\w\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 8);

    // 并行搜索多个关键词，取并集去重
    const seen = new Set();
    const results = [];

    for (const word of words) {
      const hits = searchGraph(word, { limit: 3 });
      for (const entity of hits) {
        if (!seen.has(entity.id)) {
          seen.add(entity.id);
          results.push({
            id: entity.id,
            type: entity.type,
            name: entity.properties?.name || entity.id,
            summary: summarizeEntity(entity),
            matchWord: word
          });
        }
      }
      if (results.length >= 5) break;
    }

    return results;
  }

  /**
   * sync — 回复后自动写入新记忆
   * @param {string} userMessage — 用户消息
   * @param {string} assistantResponse — 助手回复
   * @returns {object} — { saved: boolean, id?: string, reason?: string }
   */
  sync(userMessage, assistantResponse) {
    const detected = detectAutoSave(userMessage, assistantResponse);

    if (!detected || !detected.trigger) {
      return { saved: false, reason: 'no-trigger' };
    }

    const now = new Date().toISOString().slice(0, 10);
    const prefixMap = {
      'Document': 'doc',
      'Person': 'person',
      'Policy': 'policy',
      'Event': 'event',
      'Project': 'proj'
    };
    const prefix = prefixMap[detected.type] || 'entity';
    const id = generateId(prefix);

    const record = {
      op: 'create',
      entity: {
        id,
        type: detected.type,
        properties: {
          ...detected.content,
          auto_saved: true,
          user_message_preview: userMessage.slice(0, 100)
        },
        created: now,
        updated: now
      }
    };

    appendRecord(record);
    this._lastWritten = id;

    return { saved: true, id, type: detected.type };
  }

  /**
   * 用 scrubber 处理流式输出片段
   * @param {string} delta — 增量文本
   * @returns {string} — 过滤后的文本
   */
  scrub(delta) {
    const visible = this.scrubber.feed(delta);
    this.scrubber.flush();
    return visible;
  }

  /**
   * 获取最后一轮写入的记录 ID
   */
  lastWritten() {
    return this._lastWritten;
  }
}

module.exports = {
  TurnLifecycle,
  detectAutoSave
};
