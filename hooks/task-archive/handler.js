/**
 * task-archive hook — 任务工作流存档 (v2)
 *
 * 改进：
 * - 自动归档：不再等用户说"完成"，通过 inactivity 超时自动触发
 * - 更精准的任务检测：结合"好/可以/行了"判断步骤完成
 * - 30分钟无新步骤 → 自动归档（用户没再说新内容 = 任务结束了）
 * - 任务期间没有新步骤就开始新任务 → 归档上一个
 */

const fs = require('fs');
const path = require('path');

const TASK_FILE = path.join(__dirname, '../../workspace/memory/ontology/task_session.json');
const DB = {
  host: '127.0.0.1',
  port: 5432,
  database: 'openclaw',
  user: 'postgres',
  password: process.env.PG_PASSWORD || 'openclaw_pg_2026'
};

// ─── task session 状态管理 ─────────────────────────────────────────────────

function loadTaskSession() {
  try {
    if (fs.existsSync(TASK_FILE)) {
      const data = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'));
      // 检查是否超时（30分钟无活动则自动归档）
      if (data.lastActivity && (Date.now() - data.lastActivity > 30 * 60 * 1000)) {
        if (data.name) {
          // 超时自动归档
          archiveTaskSilent(data).catch(() => {});
        }
        fs.unlinkSync(TASK_FILE);
        return null;
      }
      return data;
    }
  } catch {}
  return null;
}

function saveTaskSession(session) {
  session.lastActivity = Date.now();
  fs.writeFileSync(TASK_FILE, JSON.stringify(session, null, 2));
}

function clearTaskSession() {
  try { fs.unlinkSync(TASK_FILE); } catch {}
}

// ─── 数据库 ───────────────────────────────────────────────────────────────

async function pgQuery(sql, params = []) {
  const { Client } = require('pg');
  const client = new Client(DB);
  await client.connect();
  const res = await client.query(sql, params);
  await client.end();
  return res;
}

async function appendEntity(record) {
  const {
    id, type, properties,
    ttl_days = null, source = 'task_archive'
  } = record;
  const p = typeof properties === 'string' ? properties : JSON.stringify(properties);
  const expiresAt = ttl_days
    ? new Date(Date.now() + ttl_days * 86400 * 1000).toISOString()
    : null;

  await pgQuery(`
    INSERT INTO knowledge_entities (id, entity_type, properties, text_content, embedding, ttl_days, expires_at, source, confidence, last_validated_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, 0.5, NOW(), NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      properties = EXCLUDED.properties,
      ttl_days = EXCLUDED.ttl_days,
      expires_at = EXCLUDED.expires_at,
      updated_at = NOW()
  `, [id, type, p, p, ttl_days, expiresAt, source]);
}

// ─── 任务识别 patterns ────────────────────────────────────────────────────

const TASK_START_PATTERNS = [
  /帮我[生成做写创建]/,
  /请帮我/,
  /生成.*文档/,
  /写.*报告/,
  /做.*方案/,
  /整理.*记录/,
  /分析.*数据/,
];

const DECIDE_PATTERNS = [
  /决定[用选]/,
  /采用[方案策略]/,
  /选择[了]/,
  /[确决]定了/,
  /就用.*了/,
];

const STEP_PATTERNS = [
  /(?:第一步|step.1)[完成好了]/,
  /(?:第二步|step.2)[完成好了]/,
  /(?:第三步|step.3)[完成好了]/,
  /完成.*第.*步/,
  /步骤.*完成/,
  /做好了/,
  /好.*继续/,
  /可以.*下一步/,
  /进行下一步/,
];

// 用户表达了接受/满足信号 = 任务可能完成
const ACCEPT_PATTERNS = [
  /可以了/,
  /行(啊|吧)?/,
  /好的/,
  /没问题/,
  /就这样/,
  /搞定/,
  /完成了/,
];

// 忽略的消息（不触发任务逻辑）
const IGNORE_PATTERNS = [
  /^好/,
  /^嗯/,
  /^ok/,
  /^好哒/,
  /^收到/,
  /^了解/,
];

// ─── 提取器 ───────────────────────────────────────────────────────────────

function extractTaskName(userMsg) {
  const match = userMsg.match(/(?:帮我|请|生成|做|写|创建)?(.{2,30}?)(?:文件|报告|文档|方案|竞标|内容|记录|周报|月报|总结)/);
  return match ? match[1].trim() : userMsg.slice(0, 40);
}

function extractDecision(userMsg) {
  const match = userMsg.match(/(?:决定|采用|选择)[用选了]*(.{2,50})/);
  return match ? match[1].trim() : null;
}

function isIgnoredMsg(msg) {
  return IGNORE_PATTERNS.some(p => p.test(msg.trim()));
}

// ─── 归档写入（静默版，不打印日志）────────────────────────────────────────

async function archiveTaskSilent(session) {
  if (!session || !session.name) return null;
  const { name, workflow, decisions, startTime, endTime } = session;
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const entityId = `task_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`;
  const duration = endTime && startTime
    ? Math.round((new Date(endTime) - new Date(startTime)) / 60000)
    : (startTime ? Math.round((Date.now() - new Date(startTime)) / 60000) : null);

  await appendEntity({
    id: entityId,
    type: 'TaskArchive',
    properties: {
      name,
      workflow: workflow || [],
      decisions: decisions || [],
      duration_minutes: duration,
      started_at: startTime,
      ended_at: endTime || new Date().toISOString(),
      outcome: 'completed',
      source: 'task_archive',
    },
    ttl_days: 90,
  });

  return entityId;
}

// ─── 主 handler ───────────────────────────────────────────────────────────

const handler = async (event) => {
  if (event.type !== 'message' || event.action !== 'received') return;

  const body = event.context && (
    event.context.body ||
    event.context.content ||
    event.context.bodyForAgent
  );
  if (!body || typeof body !== 'string') return;

  // 忽略简单应答消息
  if (isIgnoredMsg(body)) return;

  const now = Date.now();
  let session = loadTaskSession();

  // ── 检测新任务开始（同时会归档旧任务）──────────────────────────────
  const isNewTask = TASK_START_PATTERNS.some(p => p.test(body));
  if (isNewTask) {
    // 如果有未完成的旧任务，先自动归档
    if (session && session.name) {
      const prevId = await archiveTaskSilent(session);
      if (prevId) console.log(`[task-archive] auto-archived previous: ${prevId}`);
      clearTaskSession();
    }

    const taskName = extractTaskName(body);
    session = {
      id: `task_${now}`,
      name: taskName,
      workflow: [],
      decisions: [],
      startTime: new Date().toISOString(),
      endTime: null,
      lastActivity: now,
      stepCount: 0,
    };
    saveTaskSession(session);
    console.log(`[task-archive] started: ${taskName}`);
    return;
  }

  if (!session || !session.name) return;

  // ── 检测步骤完成 ─────────────────────────────────────────────────────
  const isStep = STEP_PATTERNS.some(p => p.test(body));
  if (isStep) {
    session.stepCount = (session.stepCount || 0) + 1;
    session.workflow = session.workflow || [];
    session.workflow.push({
      step: session.stepCount,
      text: body.slice(0, 80),
      at: new Date().toISOString()
    });
    session.endTime = new Date().toISOString(); // 重置结束时间
    saveTaskSession(session);
    console.log(`[task-archive] step ${session.stepCount}: ${body.slice(0, 40)}`);
    return;
  }

  // ── 检测决策 ─────────────────────────────────────────────────────────
  if (DECIDE_PATTERNS.some(p => p.test(body))) {
    const decision = extractDecision(body);
    if (decision) {
      session.decisions = session.decisions || [];
      session.decisions.push({ text: decision, at: new Date().toISOString() });
      saveTaskSession(session);
      console.log(`[task-archive] decision: ${decision}`);
    }
  }

  // ── 自动完成检测 ─────────────────────────────────────────────────────
  // 如果用户表达了接受信号，且有≥1个步骤 → 自动归档
  const isAccept = ACCEPT_PATTERNS.some(p => p.test(body));
  if (isAccept && (session.workflow || []).length >= 1) {
    session.endTime = new Date().toISOString();
    const { id: entityId } = await archiveTaskSilent(session).catch(() => ({ id: null }));
    clearTaskSession();
    if (entityId) {
      console.log(`[task-archive] auto-archived on accept: ${entityId}`);
      const notifyText = `<task-archive>\n✅ 任务已自动归档: ${session.name}\n</task-archive>`;
      if (Array.isArray(event.messages)) event.messages.push(notifyText);
    }
    return;
  }

  // 更新最后活跃时间
  session.lastActivity = now;
  saveTaskSession(session);
};

export default handler;