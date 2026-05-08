# 🧠 知识图谱系统 (Knowledge Graph System)

基于 Hermes Agent 架构设计的主动记忆召回系统，支持向量语义搜索、关系遍历、自动归档。

---

## 📁 架构总览

```
用户发消息
    ↓
message:received（task-archive 记录任务步骤）
    ↓
message:preprocessed
    ├→ ontology-recall（语义搜索 + auto-sync 写入）
    └→ <graph-recall> 注入 agent 上下文
    ↓
agent:bootstrap（ontology-bootstrap 注入图谱摘要）
```

---

## 🗄️ 数据库

**PostgreSQL + pgvector**（Docker 容器 `openclaw-pg`，端口 5432）

```sql
-- 主实体表
knowledge_entities(
  id TEXT PRIMARY KEY,
  entity_type TEXT,           -- Document / Event / Policy / Preference / TaskArchive / Tool / Project / Delegation
  properties JSONB,           -- 实体属性
  text_content TEXT,         -- 文本内容（用于搜索）
  embedding vector(1536),     -- MiniMax embo-01 向量
  confidence REAL DEFAULT 0.5,        -- 置信度（0~1）
  last_accessed_at TIMESTAMPTZ,      -- 上次访问时间
  access_count INTEGER DEFAULT 0,   -- 访问次数
  last_validated_at TIMESTAMPTZ,    -- 上次验证时间
  ttl_days INTEGER,                   -- TTL天数（NULL=永不过期）
  expires_at TIMESTAMPTZ,            -- 过期时间
  source TEXT DEFAULT 'manual',       -- 来源（manual/auto/sync/task_archive）
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

-- 关系表
entity_relations(
  id TEXT PRIMARY KEY,
  from_id TEXT,
  to_id TEXT,
  relation_type TEXT,        -- controls / contains / depends_on / etc.
  properties JSONB,
  created_at TIMESTAMPTZ
)
```

---

## 🪝 钩子（Hooks）

### 1. `ontology-bootstrap`

**事件：** `agent:bootstrap`（会话开始）

**功能：**
- 读取 `memory/ontology/graph.jsonl`
- 生成图谱摘要（实体数量、最近更新时间、每条实体一行摘要）
- 注入到 SOUL.md 头部

**文件：** `~/.openclaw/hooks/ontology-bootstrap/handler.js`

---

### 2. `ontology-recall`（核心）

**事件：** `message:preprocessed`（每条消息预处理后）

**功能：**
1. MiniMax embo-01 把消息 embedding 成 1536 维向量
2. pgvector 余弦相似度搜索 top-5 实体
3. 置信度调整（每7天 -0.05，每次访问 +0.002）
4. 有效分数过滤（similarity × confidence > 0.12）
5. 冲突检测（同类型相似度差值 ≤ 0.1 时标记冲突）
6. 1-hop 直接关系 + 2-hop 路径查找
7. 注入 `<graph-recall>` 到 agent 上下文

**auto-sync 自动写入（20个 pattern）：**

| # | 触发关键词 | 类型 | TTL |
|---|-----------|------|-----|
| 1 | npm install / 装一个skill | Document | 30天 |
| 2 | 卸载skill | Document | 30天 |
| 3 | 小说章节发布 | Event | 30天 |
| 4 | 决定用/采用方案/拍板 | Policy | 永不过期 |
| 5 | 我喜欢/想要/不要 | Preference | 365天 |
| 6 | exec输出中检测到安装 | Document | 30天 |
| 7 | 发现bug/报错了/空指针 | Event | 30天 |
| 8 | 好想法/灵感/脑洞 | Event | 60天 |
| 9 | review完成/代码审完 | Event | 30天 |
| 10 | 部署完成/上线/发版 | Event | 90天 |
| 11 | 测试通过/冒烟测试/回归 | Event | 30天 |
| 12 | 调研完成/结论是 | Event | 60天 |
| 13 | 会议结束/达成一致 | Event | 60天 |
| 14 | 风险/隐患/需要注意 | Event | 60天 |
| 15 | 卡住了/blocker/行不通 | Event | 30天 |
| 16 | 截止时间/deadline | Event | 30天 |
| 17 | 成功了/里程碑/超额完成 | Event | 90天 |
| 18 | 同步进度/周报/汇报 | Event | 14天 |
| 19 | 新增依赖/加了个包 | Event | 60天 |
| 20 | 接口改了/API变更 | Event | 90天 |

**文件：** `~/.openclaw/hooks/ontology-recall/handler.js`

---

### 3. `task-archive`

**事件：** `message:received`（每条消息）

**功能：** 任务工作流自动追踪与归档

**触发条件：**
- 启动：消息匹配"帮我生成/写/做..."（TASK_START_PATTERNS）
- 步骤：说"第一步完成了"/"好，继续"
- 决策：说"决定用方案A"
- 完成（自动）：说"可以了"/"行"/"好的"，或 30 分钟无活动

**归档写入（TaskArchive）：**
```json
{
  "id": "task_20260508_001",
  "entity_type": "TaskArchive",
  "properties": {
    "name": "生成竞标文件",
    "workflow": [
      { "step": 1, "text": "竞品分析完成", "at": "..." },
      { "step": 2, "text": "撰写正文", "at": "..." }
    ],
    "decisions": [
      { "text": "采用对比表格形式", "at": "..." }
    ],
    "duration_minutes": 25,
    "started_at": "...",
    "ended_at": "...",
    "outcome": "completed"
  },
  "ttl_days": 90
}
```

**文件：** `~/.openclaw/hooks/task-archive/handler.js`

---

## 📂 文件结构

```
memory/ontology/
├── graph.jsonl              # 图谱主存储（30条实体）
├── graph_ops.js            # GraphOperations + StreamingContextScrubber
├── provider.js             # KnowledgeGraphProvider（Hermes MemoryProvider 风格）
├── session_context.js     # SessionContext（会话元数据注入）
├── turn_lifecycle.js        # TurnLifecycle（prefetch/sync 自动化）
├── subagent_delegation.js  # 子代理任务→结果记录
├── embed_client.js         # MiniMax embo-01 embedding 客户端
├── sync-to-pgvector.py    # 图谱→pgvector 同步脚本
├── sync-to-pgvector.js     # JS 版同步（备用）
├── bm25_search.js          # BM25 备用搜索（无需外部服务）
├── bm25_indexer.js         # BM25 索引构建
├── bm25/graph.bm25.idx     # BM25 索引文件
└── UPDATE_RULES.md         # 更新规则文档

hooks/
├── ontology-bootstrap/      # agent:bootstrap 钩子
├── ontology-recall/         # message:preprocessed 钩子（核心）
└── task-archive/           # message:received 任务追踪钩子
```

---

## 🔧 核心工具函数

### 向量搜索

```javascript
const { embedQuery } = require('./embed_client');
const vec = await embedQuery("巢都之下小说更新");
// → float[1536]
```

### 图谱操作

```javascript
const { appendRecord, searchGraph, getEntityById } = require('./graph_ops');
```

### 数据库查询

```python
# 用法：pgvector 余弦相似度
SELECT id, entity_type, properties,
       1 - (embedding <=> '[0.1, 0.2, ...]'::vector) AS similarity
FROM knowledge_entities
WHERE embedding IS NOT NULL
ORDER BY embedding <=> '[...]'::vector
LIMIT 5;
```

---

## ⚙️ MiniMax API 配置

```javascript
API_KEY=<YOUR_MINIMAX_API_KEY>
ENDPOINT=https://api.minimaxi.com/v1/embeddings
MODEL=embo-01
DIM=1536
```

---

## 🚀 快速测试

```bash
# 测试 pgvector 搜索
cd workspace
uv run --with psycopg2-binary python3 -c "
import urllib.request, json, psycopg2

def embed_query(text):
    req = urllib.request.Request(
        'https://api.minimaxi.com/v1/embeddings',
        data=json.dumps({'model': 'embo-01', 'texts': [text], 'type': 'query'}).encode(),
        headers={'Authorization': 'Bearer <API_KEY>', 'Content-Type': 'application/json'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())['vectors'][0]

conn = psycopg2.connect(host='127.0.0.1', port=5432, database='openclaw',
                        user='postgres', password=os.environ.get('PG_PASSWORD', '<YOUR_PG_PASSWORD>'))
cur = conn.cursor()
vec = embed_query('巢都之下')
vec_str = '[' + ','.join(str(x) for x in vec) + ']'
cur.execute(f'SELECT id, entity_type, 1-(embedding<=>\"{vec_str}\"::vector) AS sim '
            f'FROM knowledge_entities WHERE embedding IS NOT NULL '
            f'ORDER BY embedding<=>\"{vec_str}\"::vector LIMIT 5')
for r in cur.fetchall(): print(r)
conn.close()
"
```

---

## 📝 提交记录

```
7ec2e95 feat: expand auto-sync to 20 patterns with extended keywords
832f4be feat: pgvector + MiniMax embeddings + relation traversal
a508bbb add: 2026-05-08 daily memory (ontology-bootstrap hook)
1f62525 add: knowledge graph loading rule to IDENTITY.md
5a4f60e add: knowledge graph loading rule to AGENTS/HEARTBEAT/TOOLS_INVENTORY
3163a78 🦞 今日工作汇总（2026-05-07）
```

---

## ⚠️ 注意事项

1. **钩子文件在 `~/.openclaw/hooks/`，备份在 `workspace/hooks/`**
2. **gateway 重启后钩子自动生效，无需手动加载**
3. **pgvector Docker 容器名：`openclaw-pg`，端口 5432**
4. **auto-sync 去重：同一 skill 同一天不重复写入**
5. **task-archive 30分钟超时自动归档上一个任务**

---

🦞 赛博 five 的知识图谱系统 | Built on Hermes-style architecture