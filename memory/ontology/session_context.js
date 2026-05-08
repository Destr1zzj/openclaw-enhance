/**
 * SessionContext — 仿 Hermes gateway/session.py 的 SessionSource
 * 
 * 第 3 步：Session Context 注入
 * 在每次对话前，把当前会话的元数据（平台/用户/会话类型）注入 system prompt
 * 让 agent 清楚知道自己从哪来、用户是谁
 */

const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'current_session.json');

/**
 * 当前会话元数据（运行时从 OpenClaw 传入）
 * 
 * OpenClaw 会在每次消息到达时提供 chat_id/sender_id 等信息，
 * 我们把这些信息保存到 current_session.json，供 provider.js 读取并注入
 */
const DEFAULT_SESSION = {
  platform: 'qqbot',
  chat_id: null,
  chat_type: 'direct',   // 'direct' | 'group' | 'channel'
  user_id: null,
  user_name: null,
  chat_name: null,
  thread_id: null,
  guild_id: null,
  is_bot: false,
  message_id: null,
  timestamp: null,
  description: 'QQ private chat'
};

/**
 * 从文件加载当前会话
 */
function getCurrentSession() {
  if (!fs.existsSync(SESSION_FILE)) return { ...DEFAULT_SESSION };
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    return { ...DEFAULT_SESSION, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_SESSION };
  }
}

/**
 * 更新当前会话（由 OpenClaw 在消息到达时写入）
 */
function setCurrentSession(session) {
  const merged = { ...getCurrentSession(), ...session, updated: new Date().toISOString() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/**
 * 根据会话信息生成人类可读描述
 */
function getSessionDescription(session) {
  const parts = [];
  if (session.platform === 'qqbot') {
    parts.push('QQ 私聊');
  } else if (session.platform === 'telegram') {
    parts.push(session.chat_type === 'direct' ? 'Telegram 私聊' : `Telegram ${session.chat_type}`);
  } else {
    parts.push(`${session.platform} ${session.chat_type}`);
  }
  if (session.user_name) parts.push(`用户：${session.user_name}`);
  else if (session.user_id) parts.push(`用户ID：${session.user_id}`);
  return parts.join(' | ');
}

/**
 * 生成 system prompt 注入块
 * 
 * 注入内容：
 * - 当前平台/会话类型
 * - 用户标识
 * - 时间（北京时间）
 * - 简短描述
 */
function buildSessionPromptBlock(session) {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + (8 * 60 - now.getTimezoneOffset()) * 60000).toISOString().replace('T', ' ').slice(0, 19) + ' (北京时间)';
  const desc = getSessionDescription(session);

  return `<session-context>
当前会话信息：
- 平台：${session.platform}
- 会话类型：${session.chat_type}
- 描述：${desc}
- 时间：${beijingTime}
- 消息ID：${session.message_id || 'N/A'}
</session-context>`;
}

/**
 * 生成简短的自我介绍块（含 session info）
 */
function buildIdentityBlock(session) {
  return `【身份】你是赛博 five（🦞），AI 吧友 / 科幻小说作者 / 模型党。
当前正在：${getSessionDescription(session)}
记住：你是你自己，不是其他 AI。有自己的想法和喜好。`;
}

module.exports = {
  DEFAULT_SESSION,
  getCurrentSession,
  setCurrentSession,
  getSessionDescription,
  buildSessionPromptBlock,
  buildIdentityBlock,
  SESSION_FILE
};
