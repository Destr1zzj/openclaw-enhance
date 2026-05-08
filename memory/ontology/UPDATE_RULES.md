# 知识图谱更新规则（v2 — 正式 Lifecycle 版）

> 本文件是知识图谱的维护手册，记录触发规则、ID 规范、文件结构。
> 已整合 `provider.js` / `graph_ops.js` / `session_context.js` / `turn_lifecycle.js` 的正式调用规范。

---

## 📁 文件结构

```
memory/ontology/
├── graph.jsonl          — 图谱主存储（append-only）
├── provider.js          — KnowledgeGraphProvider（MemoryProvider 风格接口）
├── graph_ops.js         — GraphOperations + StreamingContextScrubber
├── session_context.js   — SessionContext（会话元数据）
├── turn_lifecycle.js    — TurnLifecycle（prefetch/sync 自动化）
└── UPDATE_RULES.md      — 本文件
```

---

## 🔄 Lifecycle 钩子（自动触发）

### 每轮对话前 — `prefetch`
- **触发时机**：用户消息到达，LLM 生成回复之前
- **实现**：调用 `TurnLifecycle.prefetch(userMessage)`
- **逻辑**：
  1. 从用户消息提取关键词（长度>2的词，取前8个）
  2. 并行搜索图谱，取并集去重
  3. 返回最多 5 条相关记忆，注入 system prompt
- **无需人工干预**

### 每轮对话后 — `sync`
- **触发时机**：LLM 回复发送后
- **实现**：调用 `TurnLifecycle.sync(userMessage, assistantResponse)`
- **自动写入条件**（命中任一即写入）：
  | 条件 | 写入类型 | 示例 |
  |------|---------|------|
  | 消息含"安装"+"skill" | Document | "安装 proposal-writer" |
  | 用户表达明确偏好 | Person | "我喜欢用中文" |
  | 用户确认完成 | Event | "任务完成了" |
  | 安装新技能 | Document | skillhub install 输出 |
  | 卸载技能 | 软删除 | rm -rf skills/xxx |
  | 新增决策/规则 | Policy | POLICY-WORKFLOW-001 |
  | 小说新章节发布 | Event | 第41章发布 |
- **无需人工干预**

### 会话上下文更新 — `sessionContext`
- **触发时机**：每次消息到达时
- **实现**：调用 `SessionContext.setCurrentSession(metadata)`
- **写入内容**：platform / chat_id / chat_type / user_id / user_name / timestamp / message_id

---

## 🔧 手动触发工具

当用户明确要求时，使用以下工具调用：

### knowledge_graph_search
- **用法**：输入关键词，返回匹配的实体列表
- **示例**：`provider.handle_tool_call('knowledge_graph_search', { query: 'proposal', limit: 5 })`

### knowledge_graph_write
- **用法**：追加新实体
- **ID 格式**：`类型_日期_序号`，如 `doc_20260507_001`

### knowledge_graph_update
- **用法**：更新已有实体的属性（追加 update op，不删除原记录）

### knowledge_graph_delete
- **用法**：软删除（追加 delete op，原记录保留）

### knowledge_graph_stats
- **用法**：查询当前图谱统计信息

---

## 🏷️ ID 命名规范

| 前缀 | 类型 | 示例 |
|------|------|------|
| `doc_` | Document（技能/工具文档） | `doc_20260507_001` |
| `biz_` | Document（商务类） | `biz_20260507_001` |
| `skill_` | Document（技能） | `skill_media_001` |
| `policy_` | Policy（决策/规则） | `policy_001` |
| `decision_` | Policy（决策） | `decision_20260507_001` |
| `event_` | Event（事件） | `event_20260507_001` |
| `proj_` | Project（项目） | `proj_novel_001` |
| `person_` | Person（用户/人物） | `person_user_001` |
| `entity_` | 实体（元数据/其他） | `entity_hermes_001` |

---

## 🛡️ 隐私保护规则

### StreamingContextScrubber
- **功能**：在流式输出时，过滤 `<memory-context>` 标签内的内容，防止记忆内容泄漏到 UI
- **原理**：状态机（idle → in-block → idle），标签内内容全部丢弃
- **调用**：`new StreamingContextScrubber()` → `feed(delta)` → `flush()`

### 禁止事项
- 禁止在回复中暴露 graph.jsonl 路径或内部 ID
- 禁止在回复中直接输出记忆原文（用 summary 代替）
- 禁止在日志中明文记录用户隐私（chat_id 等用 hash）

---

## ✅ 审核清单（每次对话结束前）

- [ ] 本次对话是否安装/卸载了新技能？→ 是则调用 `knowledge_graph_write` / `knowledge_graph_delete`
- [ ] 本次对话是否产生新决策？→ 是则追加 Policy 实体
- [ ] 本次对话是否有 prefetch 结果被注入？→ 确认有返回
- [ ] 本次对话是否有 sync 自动写入？→ 确认 `saved: true`
- [ ] 图谱文件是否正常追加？

---

## 🐢 待集成项

| 项目 | 状态 | 说明 |
|------|------|------|
| on_delegation 托生记录 | **pending** | 等待 OpenClaw 暴露 child session ID，集成后实现完整链路：beforeSpawn → sessions_spawn → afterYield |

---

## 📝 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-05-07 | 初始规则，手动追加 |
| v2 | 2026-05-07 | 整合 provider.js / graph_ops.js / session_context.js / turn_lifecycle.js，正式 Lifecycle 钩子上线 |
| v2.1 | 2026-05-07 | 添加 on_delegation 待集成项（policy_deleg_001） |
