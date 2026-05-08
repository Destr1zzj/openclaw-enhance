---
name: ontology-bootstrap
description: "Load knowledge graph module (graph_ops.js) during agent bootstrap for every session"
homepage: https://github.com/openclaw/openclaw
metadata:
  { "openclaw": { "emoji": "🧠", "events": ["agent:bootstrap"], "requires": { "config": ["workspace.dir"] }, "install": [{"id": "workspace", "kind": "workspace"}] } }
---

# ontology-bootstrap

在每次 `agent:bootstrap` 阶段验证知识图谱模块（`memory/ontology/graph_ops.js`）是否可正常加载。

## 功能

- 在每个会话的 bootstrap 阶段自动验证图谱模块
- 若加载失败，将错误信息注入引导文件（SOUL.md 末尾追加警告）
- 成功时静默跳过，不污染引导上下文
- 可通过 `openclaw hooks info ontology-bootstrap` 查看状态

## 触发时机

`agent:bootstrap` — 工作区引导文件注入前运行

## 依赖

- `workspace.dir` 配置项（OpenClaw 标准配置）
- `memory/ontology/graph_ops.js` 存在于工作区

## 加载的工具（无需验证，直接使用）

- `knowledge_graph_search` — 搜索图谱
- `knowledge_graph_write` — 追加新实体
- `knowledge_graph_update` — 更新已有实体
- `knowledge_graph_delete` — 软删除实体
- `knowledge_graph_stats` — 查询统计