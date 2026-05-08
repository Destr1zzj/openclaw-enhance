# 🧠 Knowledge Graph System

An active memory recall system based on Hermes Agent architecture, supporting vector semantic search, relation traversal, and automatic archival.

---

## 📁 Architecture Overview

```
User sends message
    ↓
message:received (task-archive logs task steps)
    ↓
message:preprocessed
    ├→ ontology-recall (semantic search + auto-sync write)
    └→ <graph-recall> injected into agent context
    ↓
agent:bootstrap (ontology-bootstrap injects graph summary)
```

---

## 🗄️ Database

**PostgreSQL + pgvector** (Docker container `openclaw-pg`, port 5432)

```sql
-- Main entities table
knowledge_entities(
  id TEXT PRIMARY KEY,
  entity_type TEXT,           -- Document / Event / Policy / Preference / TaskArchive / Tool / Project / Delegation
  properties JSONB,           -- Entity properties
  text_content TEXT,         -- Text content (for search)
  embedding vector(1536),     -- MiniMax embo-01 embedding
  confidence REAL DEFAULT 0.5,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER DEFAULT 0,
  last_validated_at TIMESTAMPTZ,
  ttl_days INTEGER,
  expires_at TIMESTAMPTZ,
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
)

-- Relations table
entity_relations(
  id TEXT PRIMARY KEY,
  from_id TEXT,
  to_id TEXT,
  relation_type TEXT,
  properties JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```

---

## 🪝 Hooks

### 1. `ontology-bootstrap`

**Event:** `agent:bootstrap` (session start)

**Function:**
- Reads `memory/ontology/graph.jsonl`
- Generates graph summary (entity count, last update, one-line summary per entity)
- Injects into SOUL.md header

**File:** `~/.openclaw/hooks/ontology-bootstrap/handler.js`

---

### 2. `ontology-recall` (Core)

**Event:** `message:preprocessed` (after each message preprocessing)

**Function:**
1. MiniMax embo-01 embeds message into 1536-dim vector
2. pgvector cosine similarity search for top-5 entities
3. Confidence adjustment (-0.05 per 7 days, +0.002 per access)
4. Valid score filtering (similarity × confidence > 0.12)
5. Conflict detection (same type, similarity diff ≤ 0.1 → flag conflict)
6. 1-hop direct relations + 2-hop path lookup
7. Inject `<graph-recall>` into agent context

**auto-sync auto-write (20 patterns):**

| # | Trigger Keywords | Type | TTL |
|---|----------------|------|-----|
| 1 | npm install / install a skill | Document | 30 days |
| 2 | uninstall a skill | Document | 30 days |
| 3 | novel chapter published | Event | 30 days |
| 4 | decided to use / adopted plan / finalize | Policy | never expires |
| 5 | I like / I want / I don't want | Preference | 365 days |
| 6 | detected installation in exec output | Document | 30 days |
| 7 | found bug / error / null pointer | Event | 30 days |
| 8 | great idea / inspiration / brainwave | Event | 60 days |
| 9 | review done / code reviewed | Event | 30 days |
| 10 | deployment done / released / to production | Event | 90 days |
| 11 | tests passed / smoke test / regression | Event | 30 days |
| 12 | research done / conclusion reached | Event | 60 days |
| 13 | meeting ended / reached consensus | Event | 60 days |
| 14 | risk / concern /需要注意 | Event | 60 days |
| 15 | stuck / blocker / not working | Event | 30 days |
| 16 | deadline / due date | Event | 30 days |
| 17 | success / milestone / exceeded target | Event | 90 days |
| 18 | sync progress / weekly report | Event | 14 days |
| 19 | new dependency / added a package | Event | 60 days |
| 20 | API changed / interface updated | Event | 90 days |

**File:** `~/.openclaw/hooks/ontology-recall/handler.js`

---

### 3. `task-archive`

**Event:** `message:received` (every message)

**Function:** Automatic task workflow tracking and archival

**Trigger conditions:**
- Start: message matches "帮我生成/写/做..." (TASK_START_PATTERNS)
- Step: says "first step done" / "continue"
- Decision: says "decided to use plan A"
- Complete (auto): says "可以了" / "行" / "好的", or 30 min no activity

**Archive write (TaskArchive):**
```json
{
  "id": "task_20260508_001",
  "entity_type": "TaskArchive",
  "properties": {
    "name": "Generate bid document",
    "workflow": [
      { "step": 1, "text": "Competitor analysis done", "at": "..." },
      { "step": 2, "text": "Write main content", "at": "..." }
    ],
    "decisions": [
      { "text": "Adopted comparison table format", "at": "..." }
    ],
    "duration_minutes": 25,
    "started_at": "...",
    "ended_at": "...",
    "outcome": "completed"
  },
  "ttl_days": 90
}
```

**File:** `~/.openclaw/hooks/task-archive/handler.js`

---

## 📂 File Structure

```
memory/ontology/
├── graph.jsonl              # Graph main storage (30 entities)
├── graph_ops.js            # GraphOperations + StreamingContextScrubber
├── provider.js             # KnowledgeGraphProvider (Hermes MemoryProvider style)
├── session_context.js     # SessionContext (session metadata injection)
├── turn_lifecycle.js        # TurnLifecycle (prefetch/sync automation)
├── subagent_delegation.js  # Subagent task→result recording
├── embed_client.js         # MiniMax embo-01 embedding client
├── sync-to-pgvector.py    # Graph→pgvector sync script
├── sync-to-pgvector.js     # JS version sync (backup)
├── bm25_search.js          # BM25 backup search (no external service)
├── bm25_indexer.js         # BM25 index builder
├── bm25/graph.bm25.idx     # BM25 index file
└── UPDATE_RULES.md         # Update rules document

hooks/
├── ontology-bootstrap/      # agent:bootstrap hook
├── ontology-recall/         # message:preprocessed hook (core)
└── task-archive/           # message:received task tracking hook
```

---

## 🔧 Core Utility Functions

### Vector Search

```javascript
const { embedQuery } = require('./embed_client');
const vec = await embedQuery("巢都之下小说更新");
// → float[1536]
```

### Graph Operations

```javascript
const { appendRecord, searchGraph, getEntityById } = require('./graph_ops');
```

### Database Query

```python
# Usage: pgvector cosine similarity
SELECT id, entity_type, properties,
       1 - (embedding <=> '[0.1, 0.2, ...]'::vector) AS similarity
FROM knowledge_entities
WHERE embedding IS NOT NULL
ORDER BY embedding <=> '[...]'::vector
LIMIT 5;
```

---

## ⚙️ MiniMax API Configuration

```javascript
API_KEY=process.env.MINIMAX_API_KEY || ''
ENDPOINT=https://api.minimaxi.com/v1/embeddings
MODEL=embo-01
DIM=1536
```

---

## 🚀 Quick Test

```bash
# Test pgvector search
cd workspace
uv run --with psycopg2-binary python3 -c "
import urllib.request, json, psycopg2, os

def embed_query(text):
    req = urllib.request.Request(
        'https://api.minimaxi.com/v1/embeddings',
        data=json.dumps({'model': 'embo-01', 'texts': [text], 'type': 'query'}).encode(),
        headers={'Authorization': f'Bearer {os.environ.get(\"MINIMAX_API_KEY\")}', 'Content-Type': 'application/json'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())['vectors'][0]

conn = psycopg2.connect(host='127.0.0.1', port=5432, database='openclaw',
                        user='postgres', password=os.environ.get('PG_PASSWORD'))
cur = conn.cursor()
vec = embed_query('knowledge graph test')
vec_str = '[' + ','.join(str(x) for x in vec) + ']'
cur.execute(f'SELECT id, entity_type, 1-(embedding<=>\"{vec_str}\"::vector) AS sim '
            f'FROM knowledge_entities WHERE embedding IS NOT NULL '
            f'ORDER BY embedding<=>\"{vec_str}\"::vector LIMIT 5')
for r in cur.fetchall(): print(r)
conn.close()
"
```

---

## 📝 Git Commit History

```
39b037a docs: add MIT license and installation guide for other OpenClaw users
d0fe8f3 feat: knowledge graph system — ontology-recall, ontology-bootstrap, task-archive
832f4be feat: pgvector + MiniMax embeddings + relation traversal
a508bbb add: 2026-05-08 daily memory (ontology-bootstrap hook)
1f62525 add: knowledge graph loading rule to IDENTITY.md
5a4f60e add: knowledge graph loading rule to AGENTS/HEARTBEAT/TOOLS_INVENTORY
```

---

## ⚠️ Notes

1. **Hook files are in `~/.openclaw/hooks/`, backup in `workspace/hooks/`**
2. **Gateway restart auto-applies hooks, no manual loading needed**
3. **pgvector Docker container: `openclaw-pg`, port 5432**
4. **auto-sync dedup: same skill same day won't duplicate write**
5. **task-archive 30-min timeout auto-archives previous task**

---

🦞 赛博 five's Knowledge Graph System | Built on Hermes-style architecture