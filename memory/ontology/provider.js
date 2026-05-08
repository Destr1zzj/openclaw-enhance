/**
 * KnowledgeGraphProvider — 仿 Hermes MemoryProvider 风格的接口 v2
 * 
 * 对标 Hermes 的 agent/memory_provider.py
 * 第 2 步：集成 graph_ops.js，实现了完整的 JSONL 图谱操作 + StreamingContextScrubber
 */

const {
  GraphOperations,
  StreamingContextScrubber
} = require('./graph_ops');
const {
  getCurrentSession,
  buildSessionPromptBlock,
  buildIdentityBlock
} = require('./session_context');

const {
  loadGraphLines,
  getGraphStats,
  searchGraph,
  getEntityById,
  appendRecord,
  deleteEntity,
  summarizeEntity,
  generateId,
  GRAPH_FILE
} = GraphOperations;

// ---------------------------------------------------------------------------
// MemoryProvider 接口
// ---------------------------------------------------------------------------

const KnowledgeGraphProvider = {
  name: 'knowledge-graph',

  // ------------------------------------------------------------------
  // initialize
  // ------------------------------------------------------------------
  initialize() {
    if (!fs.existsSync(GRAPH_FILE)) {
      fs.writeFileSync(GRAPH_FILE, '', 'utf8');
    }
    return { ready: true, file: GRAPH_FILE };
  },

  // ------------------------------------------------------------------
  // is_available
  // ------------------------------------------------------------------
  is_available() {
    return fs.existsSync(GRAPH_FILE);
  },

  // ------------------------------------------------------------------
  // system_prompt_block — 静态文本块（含 session + 知识图谱状态）
  // ------------------------------------------------------------------
  system_prompt_block() {
    const stats = getGraphStats();
    const lines = loadGraphLines().filter(l => {
      try { return JSON.parse(l).op !== 'delete'; } catch { return false; }
    }).length;
    const session = getCurrentSession();

    return `${buildIdentityBlock(session)}

${buildSessionPromptBlock(session)}

${`<knowledge-graph>
你现在拥有一个结构化知识图谱（Knowledge Graph），其中记录了：
- 技能文档（名称、用途、版本、安装日期）
- 重要决策和政策规则
- 项目状态和进度
- 用户偏好和事实
- 历史事件

共 ${lines} 条有效记录${stats.lastUpdated ? `，最后更新：${stats.lastUpdated}` : ''}。

查询图谱请使用 tool: knowledge_graph_search
写入图谱请使用 tool: knowledge_graph_write
更新图谱请使用 tool: knowledge_graph_update
删除记录请使用 tool: knowledge_graph_delete
</knowledge-graph>`}`;
  },

  // ------------------------------------------------------------------
  // prefetch — 对话前搜索相关记忆
  // ------------------------------------------------------------------
  prefetch(query, userContext = {}) {
    if (!query || query.trim().length < 2) return [];
    const results = searchGraph(query, { limit: 5 });
    return results.map(entity => ({
      id: entity.id,
      type: entity.type,
      name: entity.properties?.name || entity.properties?.title || entity.id,
      summary: summarizeEntity(entity),
      properties: entity.properties
    }));
  },

  // ------------------------------------------------------------------
  // sync_turn — 回复后同步（暂不自动写入，由工具调用触发）
  // ------------------------------------------------------------------
  sync_turn(userMessage, assistantResponse) {
    // 自动记忆写入由 UPDATE_RULES.md 规则驱动，此处留空
  },

  // ------------------------------------------------------------------
  // get_tool_schemas — 暴露给 LLM 的工具列表
  // ------------------------------------------------------------------
  get_tool_schemas() {
    return [
      {
        name: 'knowledge_graph_search',
        description: '从知识图谱中搜索相关实体。输入查询关键词（名称/类型/用途），返回匹配的实体列表。',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '查询关键词' },
            limit: { type: 'integer', description: '最大返回条数', default: 5 },
            types: { type: 'array', items: { type: 'string' }, description: '限定实体类型' }
          },
          required: ['query']
        }
      },
      {
        name: 'knowledge_graph_write',
        description: '向知识图谱追加新实体。用于记录新技能、新决策、重要事件、用户偏好等。',
        input_schema: {
          type: 'object',
          properties: {
            entity: {
              type: 'object',
              description: '实体对象',
              properties: {
                id: { type: 'string', description: '唯一ID，格式：类型_日期_序号' },
                type: { type: 'string', description: '实体类型：Document/Policy/Project/Event/Person/Tool' },
                properties: { type: 'object', description: '实体属性键值对' }
              },
              required: ['id', 'type', 'properties']
            }
          },
          required: ['entity']
        }
      },
      {
        name: 'knowledge_graph_update',
        description: '更新知识图谱中已有实体的属性（追加 update op，不删除原记录）。',
        input_schema: {
          type: 'object',
          properties: {
            entity_id: { type: 'string', description: '要更新的实体ID' },
            updates: { type: 'object', description: '要更新的属性（浅合并）' }
          },
          required: ['entity_id', 'updates']
        }
      },
      {
        name: 'knowledge_graph_delete',
        description: '软删除知识图谱中的实体（追加 delete op，原记录保留）。',
        input_schema: {
          type: 'object',
          properties: {
            entity_id: { type: 'string', description: '要删除的实体ID' },
            reason: { type: 'string', description: '删除原因' }
          },
          required: ['entity_id']
        }
      },
      {
        name: 'knowledge_graph_stats',
        description: '查询图谱统计信息（记录总数、最后更新时间）。',
        input_schema: { type: 'object', properties: {} }
      }
    ];
  },

  // ------------------------------------------------------------------
  // handle_tool_call — 处理 LLM 工具调用
  // ------------------------------------------------------------------
  handle_tool_call(toolName, args) {
    switch (toolName) {
      case 'knowledge_graph_search': {
        const { query, limit = 5, types = null } = args;
        const results = searchGraph(query, { limit, types });
        return {
          results,
          count: results.length,
          summary: results.map(e => ({ id: e.id, type: e.type, name: e.properties?.name, summary: summarizeEntity(e) }))
        };
      }
      case 'knowledge_graph_write': {
        const { entity } = args;
        const now = new Date().toISOString().slice(0, 10);
        const record = {
          op: 'create',
          entity: {
            ...entity,
            created: entity.created || now,
            updated: now
          }
        };
        appendRecord(record);
        return { success: true, id: entity.id, op: 'create' };
      }
      case 'knowledge_graph_update': {
        const { entity_id, updates } = args;
        const now = new Date().toISOString().slice(0, 10);
        appendRecord({
          op: 'update',
          entity_id,
          updates: { ...updates, updated: now }
        });
        return { success: true, id: entity_id, op: 'update' };
      }
      case 'knowledge_graph_delete': {
        const { entity_id, reason = '' } = args;
        deleteEntity(entity_id, reason);
        return { success: true, id: entity_id, op: 'delete' };
      }
      case 'knowledge_graph_stats': {
        const stats = getGraphStats();
        return stats;
      }
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  },

  // ------------------------------------------------------------------
  // shutdown
  // ------------------------------------------------------------------
  shutdown() {
    return { done: true };
  },

  // ------------------------------------------------------------------
  // 导出 StreamingContextScrubber 供外部使用
  // ------------------------------------------------------------------
  createScrubber() {
    return new StreamingContextScrubber();
  }
};

const fs = require('fs');

module.exports = { KnowledgeGraphProvider, StreamingContextScrubber };
