---
name: ontology-recall
description: "Full-featured knowledge graph recall: pgvector + MiniMax embeddings + relation traversal + confidence tracking + memory decay + conflict detection + TTL expiry + auto-sync"
homepage: https://github.com/openclaw/openclaw
metadata:
  { "openclaw": { "emoji": "🧠", "events": ["message:preprocessed"], "requires": { "config": ["workspace.dir"] }, "install": [{"id": "managed", "kind": "managed"}] } }
---

# ontology-recall (v3)

全功能知识图谱主动召回钩子。

## 完整功能清单

| # | 功能 | 说明 |
|---|------|------|
| 1 | pgvector 语义搜索 | MiniMax embo-01，1536维，余弦相似度 |
| 2 | 置信度追踪 | confidence / last_accessed_at / access_count / last_validated_at |
| 3 | 记忆衰减 | 每7天 -0.05，每次访问 +0.002，范围 [0, 1] |
| 4 | 冲突检测与解决 | 同类型多实体时：差值>0.1直接取最高；差值≤0.1触发冲突标记，取置信度最高者 |
| 5 | TTL 自动过期 | ttl_days / expires_at，到期自动过滤（SQL 层） |
| 6 | 关系遍历 | 1-hop 直接关系 + 2-hop 路径 |
| 7 | auto-sync 自动写入 | 回复后检测关键词（skill/小说/决策/偏好/配置）自动写图谱 |
| 8 | 隐私过滤 | StreamingContextScrubber 防泄漏 |

## 数据库字段

**knowledge_entities:**
- `id, entity_type, properties, text_content, embedding vector(1536)`
- `confidence` (REAL, 0~1)
- `last_accessed_at, access_count, last_validated_at` (访问追踪)
- `ttl_days, expires_at` (TTL 过期)
- `source` (manual / auto / sync)
- `created_at, updated_at`

**entity_relations:**
- `id, from_id, to_id, relation_type, properties, created_at`

## 过滤与决策

- 有效分数 = similarity × confidence
- 最终注入阈值：> 0.12
- 冲突阈值：同类型实体相似度差值 ≤ 0.1 时标记冲突

## auto-sync 触发条件（20个pattern，扩写版）

| # | 触发关键词 | 类型 | TTL |
|---|-----------|------|-----|
| 1 | 安装skill/npm install/装一个技能 | Document | 30天 |
| 2 | 删除skill/卸载/uninstall/npm uninstall | Document | 30天 |
| 3 | 小说章节发布/写小说/更新/发新章节 | Event | 30天 |
| 4 | 决定用/采用方案/确认/规则修改/改成 | Policy | 永不过期 |
| 5 | 我喜欢/想要/不要/更倾向/比较喜欢 | Preference | 365天 |
| 6 | exec输出中检测到安装成功 | Document | 30天 |
| 7 | 发现bug/遇到报错/程序崩溃/修复bug | Event | 30天 |
| 8 | 好想法/灵感/突然想到/有个点子 | Event | 60天 |
| 9 | review完成/代码审完/检查完成 | Event | 30天 |
| 10 | 部署完成/上线/发版/发布版本/deploy | Event | 90天 |
| 11 | 测试通过/用例写完/跑通/验证通过 | Event | 30天 |
| 12 | 调研完成/研究结论/分析结果/结论是 | Event | 60天 |
| 13 | 会议结束/讨论结果/达成一致/确定方向 | Event | 60天 |
| 14 | 风险/隐患/需要注意/担心会/有风险 | Event | 60天 |
| 15 | 卡住了/blocker/无法推进/卡在/解决不了 | Event | 30天 |
| 16 | 截止时间/deadline/最晚要/今晚/明早/下周 | Event | 30天 |
| 17 | 成功了/搞定/里程碑/达成目标/突破 | Event | 90天 |
| 18 | 交接/同步进度/进度更新/汇报一下 | Event | 14天 |
| 19 | 新增依赖/加了包/引入库/依赖更新 | Event | 60天 |
| 20 | 接口改了/API变更/参数变化/文档更新 | Event | 90天 |

## 触发时机

`message:preprocessed`（消息预处理后、Agent 处理前）