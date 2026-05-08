/**
 * SubagentDelegation — 仿 Hermes on_delegation 钩子
 * 
 * 仿 Hermes 的 agent/memory_manager.py on_delegation 机制
 * 
 * 在 OpenClaw 中：
 * - 使用 sessions_spawn 托生子代理
 * - 使用 sessions_yield 等待结果
 * - 在 sessions_yield 返回后，记录任务→结果对到图谱
 * 
 * 等效于 Hermes 的：
 *  on_delegation(task: str, result: str, child_session_id: str)
 */

const { GraphOperations } = require('./graph_ops');

const {
  appendRecord,
  generateId,
  summarizeEntity
} = GraphOperations;

// ---------------------------------------------------------------------------
// DelegationEvent — 记录一次委托任务
// ---------------------------------------------------------------------------

/**
 * 记录一次子代理委托事件
 * 
 * @param {object} params
 * @param {string} params.task         — 托生时的任务描述
 * @param {string} params.result      — 子代理返回的结果
 * @param {string} params.childSessionId — 子代理的 session_id
 * @param {string} params.platform    — 消息平台（如 'qqbot'）
 * @param {string} params.status      — 'pending' | 'completed' | 'failed'
 * @param {object} params.metadata    — 其他元数据
 */
function recordDelegation({ task, result, childSessionId, platform = 'qqbot', status = 'completed', metadata = {} }) {
  const now = new Date().toISOString().slice(0, 10);
  const id = generateId('deleg');

  const record = {
    op: 'create',
    entity: {
      id,
      type: 'Delegation',
      properties: {
        task,
        result: result ? result.slice(0, 500) : null,  // 截断避免过长
        child_session_id: childSessionId,
        platform,
        status,
        summary: `${status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏳'} 托生任务 | ${task.slice(0, 60)}${task.length > 60 ? '...' : ''}`,
        ...metadata
      },
      created: now,
      updated: now
    }
  };

  appendRecord(record);
  return id;
}

/**
 * 更新一个已存在的委托事件状态
 * 
 * @param {string} delegationId — 委托记录 ID
 * @param {object} updates     — 要更新的字段
 */
function updateDelegation(delegationId, updates) {
  const now = new Date().toISOString().slice(0, 10);
  appendRecord({
    op: 'update',
    entity_id: delegationId,
    updates: {
      ...updates,
      updated: now
    }
  });
}

/**
 * 列出最近的委托记录
 * 
 * @param {number} limit — 返回条数
 */
function getRecentDelegations(limit = 10) {
  const lines = GraphOperations.loadGraphLines();
  // 按 ID 聚合，取最新状态（处理 update op）
  const entityMap = {};
  const entityOrder = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const entity = parsed.entity || parsed;
      if (parsed.op === 'update') {
        // 合并 update 到已有实体
        if (entityMap[parsed.entity_id]) {
          Object.assign(entityMap[parsed.entity_id].properties, parsed.updates);
          entityMap[parsed.entity_id]._updated = parsed.updates.updated;
        }
      } else if (parsed.op === 'delete') {
        delete entityMap[parsed.entity_id];
      } else if (entity.type === 'Delegation') {
        entityMap[entity.id] = {
          ...entity,
          _order: entityOrder.length
        };
        entityOrder.push(entity.id);
      }
    } catch (e) { /* skip */ }
  }

  return entityOrder
    .slice(0, limit)
    .map(id => {
      const d = entityMap[id];
      return {
        id: d.id,
        task: d.properties?.task,
        result: d.properties?.result,
        child_session_id: d.properties?.child_session_id,
        status: d.properties?.status,
        summary: d.properties?.summary,
        created: d.created,
        updated: d._updated || d.updated
      };
    });
}

// ---------------------------------------------------------------------------
// OpenClaw Sessions Bridge
// 
// 用于连接 sessions_spawn/sessions_yield 的回调钩子
// ---------------------------------------------------------------------------

/**
 * 在 sessions_spawn 之前调用，记录 pending 状态的委托事件
 */
function beforeSpawn(task, platform = 'qqbot') {
  return recordDelegation({
    task,
    result: null,
    childSessionId: null,
    platform,
    status: 'pending'
  });
}

/**
 * 在 sessions_yield 返回后调用，更新委托事件状态为 completed
 */
function afterYield(delegationId, result, childSessionId) {
  updateDelegation(delegationId, {
    result: result ? result.slice(0, 500) : null,
    child_session_id: childSessionId,
    status: 'completed'
  });
}

module.exports = {
  recordDelegation,
  updateDelegation,
  getRecentDelegations,
  beforeSpawn,
  afterYield
};
