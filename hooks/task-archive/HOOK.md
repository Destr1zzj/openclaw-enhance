---
name: task-archive
description: "Task workflow archiver — automatically tracks work content, decisions, and workflow steps across task sessions, writes final archive to knowledge graph on task completion"
homepage: https://github.com/openclaw/openclaw
metadata:
  { "openclaw": { "emoji": "📋", "events": ["message:received"], "requires": { "config": ["workspace.dir"] }, "install": [{"id": "managed", "kind": "managed"}] } }
---

# task-archive

任务工作流存档钩子。在每次任务生命周期中自动追踪工作内容、决策和工作流程，任务完成时自动归档到知识图谱。

## 功能

### 任务状态追踪

在 `~/.openclaw/workspace/memory/ontology/task_session.json` 中维护当前任务会话状态（30分钟超时自动清除）。

### 自动追踪内容

| 触发信号 | 记录内容 |
|---------|---------|
| "帮我生成/做/写/创建..." | 任务名称 + 开始时间 |
| "决定/采用/选择..." | 决策内容 + 时间 |
| "第一步完成/step.1完成..." | 工作步骤 + 顺序 |
| "完成了/存档/总结" | 触发归档写入图谱 |

### 归档写入（task_done）

任务完成时向 `knowledge_entities` 写入一条 `TaskArchive` 实体：

```json
{
  "id": "task_20260508_001",
  "entity_type": "TaskArchive",
  "properties": {
    "name": "生成竞标文件",
    "workflow": [
      { "step": 1, "text": "提取需求", "at": "..." },
      { "step": 2, "text": "撰写正文", "at": "..." }
    ],
    "decisions": [
      { "text": "采用方案A", "at": "..." }
    ],
    "duration_minutes": 25,
    "started_at": "...",
    "ended_at": "...",
    "outcome": "completed"
  },
  "ttl_days": 90
}
```

## 触发时机

`message:received` — 每条用户消息都分析，识别任务信号

## 注意事项

- 30分钟无活动自动清除 session（防止遗留垃圾状态）
- 只追踪主动开启的任务（消息包含"帮我..."才会启动追踪）
- 任务完成后 session 自动清除，数据全部进入图谱