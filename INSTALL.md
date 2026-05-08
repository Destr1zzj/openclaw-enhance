# 🚀 OpenClaw 知识图谱系统安装指南

适用于其他 OpenClaw 用户，快速部署知识图谱 + 向量搜索 + 主动召回功能。

---

## 📋 前置要求

- OpenClaw 已安装并正常运行
- Docker 已安装（用于 pgvector）
- Node.js >= 18
- MiniMax API Key（用于 embedding）

---

## 🔧 环境变量配置

在 `~/.bashrc` 或 `.env` 中设置：

```bash
export MINIMAX_API_KEY="your-minimax-api-key"
export PG_PASSWORD="your-postgres-password"
export GH_TOKEN="your-github-token"  # 可选，仅用于 push
```

**获取 MiniMax API Key：**
- 注册 https://www.minimax.io/
- 进入 API Keys 页面创建

---

## 🗄️ 步骤 1：启动 pgvector 数据库

```bash
docker run -d \
  --name openclaw-pg \
  -p 5432:5432 \
  -e POSTGRES_DB=openclaw \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  pgvector/pgvector:pg16
```

验证连接：
```bash
psql -h 127.0.0.1 -p 5432 -U postgres -d openclaw -c "SELECT 1"
```

---

## 🗄️ 步骤 2：创建数据库表

连接数据库后执行：

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_entities (
  id TEXT PRIMARY KEY,
  entity_type TEXT,
  properties JSONB,
  text_content TEXT,
  embedding vector(1536),
  confidence REAL DEFAULT 0.5,
  last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
  access_count INTEGER DEFAULT 0,
  last_validated_at TIMESTAMPTZ DEFAULT NOW(),
  ttl_days INTEGER DEFAULT NULL,
  expires_at TIMESTAMPTZ DEFAULT NULL,
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  from_id TEXT,
  to_id TEXT,
  relation_type TEXT,
  properties JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entities_embedding ON knowledge_entities USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_entities_type ON knowledge_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_relations_from ON entity_relations(from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON entity_relations(to_id);
```

---

## 📁 步骤 3：安装钩子

将 `hooks/` 目录复制到 `~/.openclaw/hooks/`：

```bash
cp -r hooks/ontology-recall ~/.openclaw/hooks/
cp -r hooks/ontology-bootstrap ~/.openclaw/hooks/
cp -r hooks/task-archive ~/.openclaw/hooks/
```

重启 Gateway：
```bash
openclaw gateway restart
```

---

## 🔄 步骤 4：同步图谱数据（可选）

如果需要把现有 `graph.jsonl` 同步到 pgvector：

```bash
cd memory/ontology
uv run --with psycopg2-binary python3 sync-to-pgvector.py
```

---

## ✅ 验证安装

发送一条消息测试：

```
你好，知识图谱测试
```

如果正常，应该能在 Gateway 日志中看到 `<graph-recall>` 标签被注入。

查看钩子状态：
```bash
openclaw hooks list
```

---

## 📂 文件说明

```
ontology-repo/
├── hooks/
│   ├── ontology-recall/     # 核心召回钩子（message:preprocessed）
│   ├── ontology-bootstrap/    # 启动摘要钩子（agent:bootstrap）
│   └── task-archive/         # 任务归档钩子（message:received）
├── memory/ontology/
│   ├── embed_client.js       # MiniMax embedding 客户端
│   ├── graph_ops.js          # 图谱操作工具
│   ├── provider.js           # KnowledgeGraphProvider
│   ├── sync-to-pgvector.py  # 数据同步脚本
│   └── bm25/                # BM25 备用搜索
├── memory/ontology/UPDATE_RULES.md  # 更新规则文档
└── README.md
```

---

## 🔧 配置说明

| 环境变量 | 说明 | 必填 |
|--------|------|-----|
| `MINIMAX_API_KEY` | MiniMax API Key | ✅ |
| `PG_PASSWORD` | PostgreSQL 密码 | ✅ |

---

## 🆘 常见问题

**Q: pgvector 连接失败？**
A: 检查 Docker 容器是否运行 `docker ps | grep openclaw-pg`，检查端口 5432 是否被占用。

**Q: embedding 失败？**
A: 确认 `MINIMAX_API_KEY` 正确，且网络可以访问 `api.minimaxi.com`。

**Q: 钩子没触发？**
A: 检查 Gateway 日志 `openclaw status`，确认钩子状态为 ready。

---

MIT License | 赛博 five | 2026