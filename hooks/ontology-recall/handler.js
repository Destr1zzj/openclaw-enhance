/**
 * ontology-recall — 全功能版 (v4)
 *
 * 改进：
 * - 去重逻辑：同一天同一实体不重复写入
 * - 更精准的实体提取：从消息中解析实际 skill/event/policy 名称
 * - 命令输出解析：可处理 exec 结果中的结构化安装信息
 * - 增强日志：每次 auto-sync 触发时输出"记录了什么"
 */

const { embedQuery } = require('../../workspace/memory/ontology/embed_client');

const DB = {
  host: '127.0.0.1',
  port: 5432,
  database: 'openclaw',
  user: 'postgres',
  password: 'openclaw_pg_2026'
};

// ─── 数据库操作 ────────────────────────────────────────────────────────────────

async function pgQuery(sql, params = []) {
  const { Client } = require('pg');
  const client = new Client(DB);
  await client.connect();
  const res = await client.query(sql, params);
  await client.end();
  return res;
}

async function semanticSearch(query, limit = 8) {
  const vec = await embedQuery(query);
  const vecStr = '[' + vec.map(x => String(x)).join(',') + ']';
  const res = await pgQuery(`
    SELECT id, entity_type, properties, text_content,
           1 - (embedding <=> $1::vector) AS similarity,
           confidence, last_accessed_at, access_count,
           last_validated_at, expires_at, ttl_days,
           source, created_at, updated_at
    FROM knowledge_entities
    WHERE embedding IS NOT NULL
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, [vecStr, limit]);
  return res.rows;
}

async function getDirectRelations(entityIds) {
  if (!entityIds.length) return [];
  const placeholders = entityIds.map((_, i) => `$${i+1}`).join(',');
  const res = await pgQuery(`
    SELECT r.from_id, r.to_id, r.relation_type,
           e.entity_type, e.properties
    FROM entity_relations r
    JOIN knowledge_entities e ON e.id = r.to_id
    WHERE r.from_id IN (${placeholders})
  `, entityIds);
  return res.rows;
}

async function get2HopRelations(entityIds) {
  if (entityIds.length < 2) return [];
  const placeholders = entityIds.map((_, i) => `$${i+1}`).join(',');
  const res = await pgQuery(`
    SELECT a.from_id, a.to_id AS mid_id, b.to_id AS end_id,
           a.relation_type AS rel1, b.relation_type AS rel2,
           e1.entity_type AS mid_type, e1.properties AS mid_props
    FROM entity_relations a
    JOIN entity_relations b ON b.from_id = a.to_id
    JOIN knowledge_entities e1 ON e1.id = a.to_id
    WHERE a.from_id IN (${placeholders})
      AND b.to_id IN (${placeholders})
      AND a.from_id != b.to_id
      AND b.to_id != a.from_id
  `, entityIds);
  return res.rows;
}

async function trackAccess(entityIds) {
  if (!entityIds.length) return;
  const now = new Date().toISOString();
  for (const id of entityIds) {
    await pgQuery(`
      UPDATE knowledge_entities
      SET last_accessed_at = $1,
          access_count = access_count + 1,
          last_validated_at = $1
      WHERE id = $2
    `, [now, id]);
  }
}

/**
 * 检查是否已存在当天的同类实体（去重）
 */
async function checkDuplicate(entityType, name, dateStr) {
  const today = dateStr || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // 检查 id 是否含当天日期 + 同类型
  const res = await pgQuery(`
    SELECT id, properties FROM knowledge_entities
    WHERE entity_type = $1
      AND id LIKE $2
  `, [entityType, `%${today}%`]);
  return res.rows;
}

async function appendEntity(record) {
  const {
    id, type, properties, relations = {},
    ttl_days = null, source = 'sync'
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
      source = EXCLUDED.source,
      updated_at = NOW()
  `, [id, type, p, p, ttl_days, expiresAt, source]);
}

// ─── 冲突检测与解决 ────────────────────────────────────────────────────────────

function detectConflicts(entities) {
  const byType = {};
  for (const e of entities) {
    const t = e.entity_type;
    if (!byType[t]) byType[t] = [];
    byType[t].push(e);
  }

  const resolved = [];
  const conflicts = [];

  for (const [type, group] of Object.entries(byType)) {
    if (group.length === 1) {
      resolved.push({ ...group[0], _conflict: false });
      continue;
    }
    group.sort((a, b) => b.similarity - a.similarity);
    const top = group[0];
    const second = group[1];

    if (top.similarity - second.similarity > 0.1) {
      resolved.push({ ...top, _conflict: false });
    } else {
      const winner = top.confidence >= second.confidence ? top : second;
      resolved.push({ ...winner, _conflict: true, _runnerUp: second });
      conflicts.push({ type, winner, runnerUp: second });
    }
  }
  return { resolved, conflicts };
}

// ─── 置信度衰减 ───────────────────────────────────────────────────────────────

function adjustConfidence(entity) {
  const now = Date.now();
  const lastAccess = entity.last_accessed_at
    ? new Date(entity.last_accessed_at).getTime()
    : 0;
  const daysSinceAccess = lastAccess ? (now - lastAccess) / 86400000 : 999;
  const agePenalty = Math.min(Math.floor(daysSinceAccess / 7) * 0.05, 0.5);
  const accessBonus = Math.min((entity.access_count || 0) * 0.002, 0.3);
  return Math.round(Math.max(0, Math.min(1, 0.5 - agePenalty + accessBonus)) * 1000) / 1000;
}

function effectiveScore(entity) {
  const conf = entity.confidence !== null && entity.confidence !== undefined
    ? entity.confidence
    : 0.5;
  return (entity.similarity || 0) * conf;
}

// ─── 格式化 ────────────────────────────────────────────────────────────────────

function formatEntity(e, showConflict = false) {
  const props = typeof e.properties === 'string'
    ? JSON.parse(e.properties)
    : (e.properties || {});
  const name = props.name || props.title || props.code || e.id;
  const role = props.role ? ` (${props.role})` : '';
  const status = props.status ? `[${props.status}] ` : '';
  const conf = e.adjustedConf !== undefined ? ` conf=${e.adjustedConf}` : '';
  const conflictStr = showConflict && e._conflict ? ' ⚠️冲突' : '';
  return `${status}${name}${role} [${e.entity_type}] (sim=${((e.similarity||0)*100).toFixed(0)}%${conf})${conflictStr}`;
}

// ─── extractAutoSave v2 — 改进版 ─────────────────────────────────────────────

/**
 * 从消息和回复中提取可自动记录的内容
 * 改进：
 * - 精准提取实际名称（不只是关键词）
 * - 检查去重（当天同类已有则跳过）
 * - 从 exec 输出解析结构化信息
 */
async function extractAutoSave(userMsg, assistantResp) {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // ── Pattern 1: skill 安装 ──────────────────────────────────────────────────
  // 匹配：安装xxxskill / skillhub install xxx / 装一个xxx技能 / npm install xxx / pip install xxx / uv add / 下一个 / 给安排一个 / 给我搞一个 / 顺便装一下 / 顺手装 / 加一个 / 顺手加 / 加个新技能 / 加个功能 / 添一个 / 装上 / 搞上 / 安上 / 下个 xxx / 搞个 xxx / 整一个 xxx / 来个 xxx / 上个 xxx
  const skillMatch = userMsg.match(/安装(?:到)?[\s]*["']?([a-zA-Z0-9_-]+)["']?\s*(?:skill|技能|插件)?/i)
    || userMsg.match(/(?:skillhub|clawhub|openclaw.*install)\s+([a-zA-Z0-9_-]+)/i)
    || userMsg.match(/(?:npm install|pip install|uv add|pnpm add|yarn add)\s+([a-zA-Z0-9_-]+)/i)
    || userMsg.match(/装(?:一个)?(?:个)?[\s'"]*([a-zA-Z0-9_-]+)(?:skill|技能|插件)/i)
    || userMsg.match(/(?:add|install)\s+([a-zA-Z0-9_-]+)\s+(?:to|with)/i)
    || userMsg.match(/(?:下一个|给安排一个|给我搞一个|顺便装一下|顺手装|加一个|顺手加|加个新技能|加个功能|添一个|装上|搞上|安上|下个\s+|搞个\s+|整一个|来个\s+|上个\s+)[\s'"]*([a-zA-Z0-9_-]+)/i)
    || assistantResp.match(/成功安装.*?[\s]['"]?([a-zA-Z0-9_-]+)['"]?/i)
    || assistantResp.match(/added\s+([a-zA-Z0-9_-]+)\s+to/i)
    || assistantResp.match(/successfully installed\s+([a-zA-Z0-9_-]+)/i);

  if (skillMatch) {
    const skillName = skillMatch[1].trim();
    const id = `skill_install_${dateStr}_${skillName}`;
    const dup = await checkDuplicate('Document', skillName, dateStr);
    if (dup.some(d => d.id.includes(skillName))) {
      console.log(`[auto-sync] SKIP: ${skillName} 已存在（今日）`);
      return null;
    }
    console.log(`[auto-sync] detected skill install: ${skillName}`);
    return {
      id,
      type: 'Document',
      properties: {
        name: skillName,
        action: 'install',
        source: 'sync',
        lastSeen: new Date().toISOString(),
        summary: `skill install from conversation: ${skillName}`
      },
      ttl_days: 30
    };
  }

  // ── Pattern 2: skill 卸载 ──────────────────────────────────────────────────
  // 匹配：删除xxx / 卸载xxx / uninstall xxx / npm uninstall xxx / 去掉xxx
  if (/删除.*(?:skill|技能|插件)|卸载.*(?:skill|技能|插件)|remove.*skill|uninstall.*skill|rm.*skill|npm uninstall|pip uninstall/i.test(userMsg)) {
    const rmMatch = userMsg.match(/(?:删除|卸载|remove|uninstall|rm)\s+["']?([a-zA-Z0-9_-]+)["']?/i);
    if (rmMatch) {
      const skillName = rmMatch[1].trim();
      console.log(`[auto-sync] detected skill removal: ${skillName}`);
      return {
        id: `skill_remove_${dateStr}_${skillName}`,
        type: 'Document',
        properties: {
          name: skillName,
          action: 'remove',
          source: 'sync',
          lastSeen: new Date().toISOString()
        },
        ttl_days: 30
      };
    }
  }

  // ── Pattern 3: 小说章节发布 ───────────────────────────────────────────────
  // 匹配：第X章 / 更新小说 / 发布章节 / 写小说 / 小说更新 / 发一个新章节
  const chapterMatch = userMsg.match(/第([一二三四五六七八九十百千万\d]+)章/)
    || assistantResp.match(/第([一二三四五六七八九十百千万\d]+)章.*发布成功/i);

  if (/小说.*(更新|发布|写)|第\d+章|发布.*章节|写.*小说|小说.*更新|发.*新章节|章节.*发布|继续写小说|小说.*继续/i.test(userMsg)) {
    const chMatch = userMsg.match(/第([一二三四五六七八九十百千万\d]+)章/);
    if (chMatch) {
      console.log(`[auto-sync] detected novel chapter: ${chMatch[0]}`);
      return {
        id: `event_novel_${dateStr}_${chMatch[1]}`,
        type: 'Event',
        properties: {
          name: chMatch[0],
          action: 'publish',
          source: 'sync',
          summary: assistantResp.slice(0, 150)
        },
        ttl_days: 30
      };
    }
  }

  // ── Pattern 4: 决策/policy ─────────────────────────────────────────────────
  // 匹配：决定用 / 采用方案 / 确认了 / 这样做 / 规则修改 / 改成xxx / POLICY / 规范更新 / 确定这样做 / 就这么办 / 定了
  if (/决定[用选]|采用[方案策略]|选择[了]|规则.*更新|规范.*更新|POLICY|policy.*修改|规则.*修改|改成|确认.*这样|就这么做|就这么定|这样定|改成.*了|确定.*方案|决策.*是|定了|拍板|拍下来|确定下来|最终.*方案|最终.*决定|就这么办|按.*来|按.*执行|执行.*方案|就这么弄|就这样|就这样吧|就这么着了|就这么地|做吧|就这么搞|要不.*算了|那就.*吧|先这样|先用.*试试|先用.*凑合|差不多.*就行|行吧|可以就这么办|先.*凑合用|先用.*对付|就这样.*得了|那就这样|那就这么办|那就这么定|那就这么算了|那就这么弄|那就这么着了|先.*凑合|先用.*对付着|就这样.*得了|就这么.*凑合|先用.*凑合着|先用.*对付着/i.test(userMsg)) {
    const decisionMatch = userMsg.match(/(?:决策|决定|采用|选择|确认|规则|定了|拍板|确定)[:：]?\s*["']?(.+)/);
    if (decisionMatch) {
      const decisionText = decisionMatch[1].trim().slice(0, 50);
      console.log(`[auto-sync] detected decision: ${decisionText}`);
      return {
        id: `policy_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
        type: 'Policy',
        properties: {
          name: decisionText,
          source: 'sync',
          summary: assistantResp.slice(0, 200)
        },
        ttl_days: null // 永不过期
      };
    }
  }

  // ── Pattern 5: 偏好表达 ───────────────────────────────────────────────────
  // 匹配：我喜欢 / 偏好 / 想要 / 不要 / 不想 / 更喜欢 / 倾向于 / 我比较喜欢 / 觉得xxx好 / 用惯了 / 习惯了 / 不想用 / 用不惯 / 用着不顺手 / 还是 xxx 吧 / 还是老样子 / 换成 xxx 吧 / 改用 xxx / 想用 xxx / 要用 xxx / 用 xxx 挺好的 / xxx 更顺眼 / xxx 好看 / xxx 顺手 / xxx 方便 / xxx 省事 / xxx 舒服 / xxx 习惯 / xxx 合我胃口 / xxx 顺我心意 / xxx 我喜欢 / xxx 我要 / xxx 我想 / xxx 我想用 / xxx 我想要 / xxx 我不喜欢 / xxx 我讨厌 / xxx 我不爱 / xxx 我排斥
  if (/我喜欢|我比较喜欢|我比较偏好|偏好.*|想要.*|不要.*|不想.*|更喜欢.*|倾向于.*|感觉.*更好|觉得.*比较|比较喜欢.*|不太喜欢|比较偏向/i.test(userMsg)) {
    const prefMatch = userMsg.match(/(?:我)?(?:比较)?(?:喜欢|想要|不要|不想|偏好|倾向于)?\s*["']?(.+)/);
    if (prefMatch && prefMatch[1].trim().length > 1) {
      console.log(`[auto-sync] detected preference: ${prefMatch[1].trim()}`);
      return {
        id: `pref_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
        type: 'Preference',
        properties: {
          name: prefMatch[1].trim().slice(0, 50),
          source: 'sync',
          preference_type: 'user_preference'
        },
        ttl_days: 365
      };
    }
  }

  // ── Pattern 6: exec 命令中的 skill 安装结果 ───────────────────────────────
  const execInstallMatch = assistantResp.match(/安装[到]?\s+([a-zA-Z0-9_-]+)\s*(?:成功|完成|from skillhub)?/i)
    || assistantResp.match(/(?:skillhub|clawhub).*install.*?([a-zA-Z0-9_-]+)/i);
  if (execInstallMatch && assistantResp.length > 20) {
    const skillName = execInstallMatch[1].trim();
    const id = `skill_install_${dateStr}_${skillName}`;
    const dup = await checkDuplicate('Document', skillName, dateStr);
    if (!dup.some(d => d.id.includes(skillName))) {
      console.log(`[auto-sync] detected exec install result: ${skillName}`);
      return {
        id,
        type: 'Document',
        properties: {
          name: skillName,
          action: 'install',
          source: 'exec_output',
          lastSeen: new Date().toISOString()
        },
        ttl_days: 30
      };
    }
  }

  // ── Pattern 7: Bug 发现 ─────────────────────────────────────────────────
  // 匹配：发现bug / 遇到报错 / 程序崩溃了 / 有个bug / 复现了 / 修复了xxx / 修了个bug / 控制台报错 / 有个问题 / 出问题了 / error / 异常 / 崩了 / 挂了 / 坏掉了 / 坏事了 / 完蛋了 / 不对了 / 出岔子了 / 翻车了 / 掉链子了 / 扯拐了 / 卡壳了 / 死机了 / 蓝屏了 / 白屏了 / 炸了 / 炸裂了 / 不 work 了 / 起不来了 / 跑不动了 / 烂了 / 废了这个 / 废了 / 坏 / 坏了 / 不行了 / 不好使了 / 用不了 / 失灵了 / 失效了 / 没反应了 / 什么都没发生
  if (/发现.*(?:bug|报错|错误|问题)|遇到.*(?:bug|报错|问题)|程序.*(?:崩溃|报错)|有个.*(?:bug|问题)|bug.*(?:复现|修复)|复现.*(?:bug|问题)|修复.*(?:bug|问题)|修.*(?:bug|报错)|解决.*(?:bug|问题)|修好了.*bug|报.*错|控制台.*(?:报错|错误)|console.*(?:error|报错)|出.*问题了|有个.*问题|问题.*出现了|出.*bug|出.*故障|故障了|报错信息|error.*(?:出现|发生)|异常.*(?:出现|捕获)|发现.*(?:error|异常)|遇到.*(?:error|异常)|runtime.*(?:error|exception)|空指针|空引用|undefined.*(?:is|not)|null.*(?:error)|找不到.*(?:文件|模块|依赖)|加载.*(?:失败|错误)|syntax.*error|崩了|挂了|坏掉了|坏事了|完蛋了|不对了|出岔子了|翻车了|掉链子了|扯拐了|死机了|蓝屏了|白屏了|炸了|炸裂了|不\s*work.*了|起不来了|跑不动了|烂了|废了|废了这个|坏|坏了|不行了|不好使了|用不了|失灵了|失效了|没反应了|什么都没发生/i.test(userMsg)) {
    const bugMatch = userMsg.match(/(?:发现|遇到|复现|修复|出现).{0,30}/);
    return {
      id: `bug_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: 'Bug发现/修复',
        action: 'bug_found',
        source: 'sync',
        summary: bugMatch ? bugMatch[0].trim() : userMsg.slice(0, 80)
      },
      ttl_days: 30
    };
  }

  // ── Pattern 8: 好想法/灵感 ──────────────────────────────────────────────
  // 匹配：好想法 / 灵感 / 突然想到 / 有个点子 / 冒出一个想法 / 突发奇想 / 脑洞 / 思路打开了 / 迸发了 / 想到个招 / 灵光一闪 / 有个思路 / 这个思路可以 / 这招好使 / 这招可以用 / 试试这招 / 我有个想法 / 我有个点子 / 我有个思路 / 说干就干 / 先试试水 / 摸着石头过河 / 走一步看一步 / 先整起来 / 先搞起来 / 先搞上 / 先整上 / 先弄个 / 搞个 / 整一个 / 试试 / 试试看 / 来试试 / 先试为敬 / 干了再说 / 干了 / 搞起 / 搞起来 / 整起 / 先干着 / 先整着 / 先搞着 / 先试试看 / 有搞头 / 有搞头 / 可以搞 / 可以试试 / 感觉可以 / 感觉行 / 应该可以 / 能行 / 应该行 / 能成 / 应该能成 / 应该能行 / 试试应该可以
  if (/好想法?|灵感[来]?|突然.*(?:想到|有个)|有个.*点子|冒.*想法|突发奇想|想到了?|冒出了|突然.*有个|脑洞|思路.*(?:打开|来了)|迸发|想到.*(?:招|法|方案)|突然.*(?:来个)|冒.*个|灵光.*(?:一闪|一现)|点子.*(?:来了|有了)|有个.*(?:想法|思路)|想.*(?:到了)|突然.*(?:闪过)|突然.*(?:有个|想)|灵机一动|灵感爆棚|想法.*(?:来了|有了)|开了.*(?:脑洞|窍)|思路.*(?:打开了|清晰了)|想通.*(?:了|点)|想.*(?:出个|个招)/i.test(userMsg) && userMsg.length > 5) {
    return {
      id: `idea_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '灵感记录',
        action: 'idea',
        source: 'sync',
        content: userMsg.slice(0, 100)
      },
      ttl_days: 60
    };
  }

  // ── Pattern 9: 代码/文档 review 完成 ────────────────────────────────────
  // 匹配：review完成 / 代码审完了 / 看完代码 / 检查完成 / 审阅完了 / review通过了 / 代码检查完 / 看完了代码 / 检查通过 / 审查通过 / 过一遍代码
  if (/review.*(?:完成|通过)|review完了|审阅.*(?:完成|通过)|看完.*(?:代码|文档)|代码.*(?:审完|看完|检查完)|文档.*review|检查.*(?:完成|通过)|代码.*review|审阅.*(?:通过|完成)|审查.*(?:通过|完成)|看完了.*(?:代码|文档)|过一遍.*(?:代码|文档)|review.*(?:pass|通过)|检查完毕|代码.*(?:检查|审查)|review一下|审一下.*代码|看看.*代码|检查.*代码|review代码/i.test(userMsg)) {
    return {
      id: `review_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: 'Review完成',
        action: 'review',
        source: 'sync',
        summary: userMsg.slice(0, 100)
      },
      ttl_days: 30
    };
  }

  // ── Pattern 10: 部署/上线 ──────────────────────────────────────────────
  // 匹配：部署完成 / 上线了 / 发布版本 / deploy完成 / 发版 / 版本发布 / 推送生产 / 部署到生产 / 正式环境 / 切正式 / 灰度发布 / 预发布 / 搞上去了 / 跑起来了 / 起起来了 / 成功上线 / 交付了 / 交付使用 / 对外服务 / 开始服务了 / 正式对外 / 正式跑了 / 正式运行 / 投产了 / 投产上线 / 开启服务 / 开启运行 / 启动了 / 开始跑 / 开始运行 / 上生产 / 搞到线上 / 部署线上 / 发布线上
  if (/部署.*(?:完成|成功)|上线了|发布.*(?:系统|版本|生产)|deploy.*(?:完成|成功)|发版了|版本.*(?:发布|上线)|推送.*(?:生产|正式)|生产.*(?:部署|发布)|正式.*(?:部署|上线)|切.*正式|灰度.*发布|预发布|发布.*正式|部署.*正式|发布.*生产|环境.*(?:切换|上线)|实例.*上线|发.*生产环境|正式.*环境.*部署|生产环境.*(?:部署|发布)|更新.*(?:正式|生产)|更新版本.*(?:上线|发布)|release.*(?:to|生产)|切生产|上了.*正式|正式.*上了|版本.*(?:release|发布)|部署新版本|更新上线/i.test(userMsg)) {
    const verMatch = userMsg.match(/(?:版本|v|version)[.\s]*([0-9.]+)/i);
    return {
      id: `deploy_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: verMatch ? `部署v${verMatch[1]}` : '部署完成',
        action: 'deploy',
        source: 'sync',
        version: verMatch ? verMatch[1] : null,
        summary: userMsg.slice(0, 100)
      },
      ttl_days: 90
    };
  }

  // ── Pattern 11: 测试完成 ────────────────────────────────────────────────
  // 匹配：测试通过 / 用例写完 / 跑通了 / 测试过了 / 测试完成 / 验证通过 / 单测通过 / 集成测试通过 / 全量测试通过 / 自动化测试 / 冒烟测试 / 回归测试 / 跑过了 / 跑通 / 没毛病 / 可以了 / 通过了 / 没问题了 / 测完了 / 测试全过 / 用例全过 / 全绿 / 绿灯 / 全 pass / 没问题 / 一切正常 / 验证完了 / 验证通过
  if (/测试.*(?:通过|完成|过了)|用例.*(?:写完|完成)|跑通.*了|测试.*(?:pass|过了)|验证.*(?:通过|完成)|测试.*(?:全部|都过了)|单测.*(?:通过|完成)|集成测试.*(?:通过|完成)|全量.*测试|自动化测试.*(?:通过|完成)|QA.*(?:通过|完成)|冒烟测试.*(?:通过|通过)|回归测试.*(?:通过|完成)|测试用例.*(?:执行完|完成)|功能测试.*(?:通过|完成)|端到端.*测试.*(?:通过|完成)|压测.*(?:通过|完成)|性能测试.*(?:通过|完成)|测试.*(?:全部通过|完成|过了)|跑完.*测试|测试.*跑完|全跑了|全部.*测试.*通过/i.test(userMsg)) {
    return {
      id: `test_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '测试通过',
        action: 'test_passed',
        source: 'sync',
        summary: userMsg.slice(0, 100)
      },
      ttl_days: 30
    };
  }

  // ── Pattern 12: 调研结论 ────────────────────────────────────────────────
  // 匹配：调研完成 / 研究结论 / 分析结果 / 结论是 / 总结是 / 调研完了 / 调研结果 / 研究发现 / 分析结论 / 评估结果 / 调研报告
  if (/调研.*(?:完成|完了)|研究.*(?:结论|结果)|分析.*(?:结果|完成)|结论是|总结.*是|调研完了|研究.*(?:结果|结论)|分析.*(?:出了|结果)|结论.*(?:出来了|确定了)|调研报告|研究发现|评估.*(?:结果|结论)|可行性.*(?:结论|结果)|调研.*(?:结果|结论)|评估.*(?:完成|通过)|评估结论|调研.*(?:发现|结论)|研究.*(?:发现|结论)|分析.*(?:得出|结论)|得出了.*结论|结论.*得出|总结.*(?:得出了|调研)|报告出来了|报告.*出来了/i.test(userMsg)) {
    return {
      id: `research_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '调研结论',
        action: 'research',
        source: 'sync',
        content: userMsg.slice(0, 150),
        summary: assistantResp.slice(0, 200)
      },
      ttl_days: 60
    };
  }

  // ── Pattern 13: 会议结论 ────────────────────────────────────────────────
  // 匹配：会议结束 / 结论是 / 讨论结果 / 达成一致 / 会议完了 / 确定了要点 / 会议要点 / 会议纪要 / 讨论决定 / 讨论结论
  if (/会议.*(?:结束|完|通过)|讨论.*(?:结果|结论)|达成.*一致|结论.*是|确定了.*(?:要点|方向)|会议.*(?:结论|结果)|定了.*(?:方向|方案)|方向.*确定|确定了.*(?:方向|方案)|会议要点|会议纪要|讨论.*决定|会议决定|商议.*(?:结果|决定)|共识.*(?:达成|形成)|达成.*共识|会议.*共识|会议.*(?:结论如下|结论如下|决定如下)|会议决定.*是|讨论.*最终|最终.*(?:决定|结论)|决定.*(?:是|如下)|一致.*决定|统一.*决定|确定了.*最终/i.test(userMsg)) {
    return {
      id: `meeting_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '会议结论',
        action: 'meeting',
        source: 'sync',
        content: userMsg.slice(0, 150)
      },
      ttl_days: 60
    };
  }

  // ── Pattern 14: 风险识别 ───────────────────────────────────────────────
  // 匹配：风险 / 隐患 / 需要注意 / 担心会 / 有风险 / 可能问题 / 潜在问题 / 风险点 / 高风险 / 风险评估 / 预警
  if (/风险|隐患|可能.*(?:问题|风险)|需要.*(?:注意|关注)|担心.*会|有.*(?:风险|隐患)|潜在.*问题|需要注意.*点|可能要.*问题|存在.*风险|高风险|风险点|风险评估|风险预案|预警|危险.*(?:信号|迹象)|风险.*(?:因素|原因)|风险.*(?:等级|级别)|风险.*(?:管控|管理)|风险.*(?:识别|发现)|注意.*(?:风险|隐患)|警惕.*风险|风险.*(?:出现|存在)|风险.*(?:来了|出现)|隐患.*(?:存在|出现)|存在.*隐患|问题.*(?:风险|隐患)|可能的.*(?:风险|问题)|不确定.*因素|不稳定.*因素|变数|未知.*风险|风险.*不可控|风险.*不确定/i.test(userMsg)) {
    return {
      id: `risk_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '风险识别',
        action: 'risk_identified',
        source: 'sync',
        content: userMsg.slice(0, 100)
      },
      ttl_days: 60
    };
  }

  // ── Pattern 15: 阻碍/卡点 ───────────────────────────────────────────────
  // 匹配：卡住了 / 阻塞 / blocker / 无法推进 / 卡在 / 解决不了 / 推进不了 / 卡壳 / 遇到瓶颈 / 堵住了
  if (/卡住了?|阻塞|blocker|无法.*(?:推进|继续)|卡在|解决不了|推进不了|卡壳了|卡死了|卡在.*(?:无法|无法)|没法.*推进|卡在.*(?:步|环节)|堵住了|无法.*(?:绕过|通过)|遇到.*(?:瓶颈|难点)|瓶颈.*在于|卡点.*在于|堵点|无法.*(?:继续|推进)|进度.*(?:卡|堵)|遇到.*(?:阻碍|障碍)|阻碍|障碍.*(?:存在|出现)|卡在.*(?:哪里|哪儿)|卡在.*(?:这|那)|卡壳|死胡同|走不通|行不通|过不去|搞不定|难推进|进度慢|延期了|延迟|推迟|推迟.*(?:到|至)|延后|滞后|落后.*(?:计划|进度)|卡住.*了|动不了|无进展|进展.*慢|没进展|卡住了.*怎么办|遇到.*(?:解决不了|搞不定)|搞不定.*(?:问题|事情)/i.test(userMsg) && userMsg.length > 5) {
    return {
      id: `blocker_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '遇到阻碍',
        action: 'blocker',
        source: 'sync',
        content: userMsg.slice(0, 100),
        status: 'open'
      },
      ttl_days: 30
    };
  }

  // ── Pattern 16: 截止时间确认 ───────────────────────────────────────────
  // 匹配：截止时间 / deadline / 最晚要 / 今晚 / 明早 / 这周 / 下周 / 限时 / 周五前 / 月底 / 季末 / deadline快到了
  if (/截止.*(?:时间|是?|前)|deadline.*(?:是?|时间|前)|最晚.*(?:要|完成|前)|今晚要|明早要|这周要|下周要|限时|什么时候要|需要.*(?:前|之前)完成|最迟|最晚.*(?:完成|前)|周五前|周日前|月底前|季末前|明天下午|下周一|本周.*(?:前|前完成)|下个月|这个月|季度.*(?:截止|结束)|财年.*(?:截止|结束)|阶段.*(?:截止|交付)|交付.*(?:时间|截止)|时间节点|节点.*(?:是|到了)|截止.*(?:是|到)|期限.*(?:是|到了)|什么时候.*(?:要|截止)|完成.*(?:时间|期限)|计划.*(?:完成|截止)|预期.*(?:完成|交付)|预计.*(?:完成|时间)|deadline.*(?:快到了|到了|临近)|大限.*将至|时间.*紧迫|紧急.*截止|加急.*完成|快到.*截止|截点在|截点.*是/i.test(userMsg)) {
    return {
      id: `deadline_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '截止时间',
        action: 'deadline_set',
        source: 'sync',
        content: userMsg.slice(0, 100)
      },
      ttl_days: 30
    };
  }

  // ── Pattern 17: 成功/里程碑 ────────────────────────────────────────────
  // 匹配：成功了 / 搞定 / 突破了 / 达成目标 / 完成目标 / 里程碑 / 破纪录 / 超额完成 / 提前完成 / 目标达成
  if (/成功了|搞定|突破了|达成.*目标|完成了.*目标|里程碑|破纪录|目标达成|达成.*业绩|超额完成|提前完成|完成.*(?:关键|重要)|关键.*(?:完成|达成)|阶段.*(?:完成|达成)|重要.*(?:完成|达成)|突破.*(?:了|目标)|超额.*(?:完成|达成)|提前.*(?:完成|达成)|目标.*(?:实现了|达到了)|实现了.*目标|达成.*(?:关键|重要)|关键节点|节点.*(?:达成|完成)|任务.*完成了|目标.*完成了|达到.*目标|目标.*实现了|完成了.*预期|超过.*预期|超越.*目标|刷新.*记录|记录.*刷新|最好.*成绩|历史.*最好/i.test(userMsg)) {
    return {
      id: `milestone_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '里程碑达成',
        action: 'milestone',
        source: 'sync',
        content: userMsg.slice(0, 100)
      },
      ttl_days: 90
    };
  }

  // ── Pattern 18: 交接/同步 ───────────────────────────────────────────────
  // 匹配：交接一下 / 同步一下 / 同步进度 / 进度更新 / 汇报一下 / 周报 / 日报 / 工作同步
  if (/交接.*(?:一下)?|同步.*(?:一下)?|同步.*(?:进度|状态)|进度.*(?:更新|同步)|汇报.*(?:一下|情况)|更新.*进度|同步.*状态|状态.*同步|工作.*(?:同步|汇报)|周报|月报|日报|工作.*(?:汇报|同步)|同步.*一下|状态.*更新|进度.*汇报|工作.*状态|情况.*汇报|汇报.*(?:工作|进展)|进展.*(?:同步|汇报)|工作进度|进度.*同步|告知.*情况|通报.*情况|同步一下.*(?:情况|进展)|对一下.*(?:进度|情况)|对齐.*(?:进度|情况)|同步.*一下.*(?:进度|情况)|工作日志|日报.*写|周报.*写|记录.*工作|工作.*记录/i.test(userMsg)) {
    return {
      id: `sync_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '进度同步',
        action: 'sync',
        source: 'sync',
        content: userMsg.slice(0, 100)
      },
      ttl_days: 14
    };
  }

  // ── Pattern 19: 新增依赖/包 ─────────────────────────────────────────────
  // 匹配：新增依赖 / 加了一个包 / 引入了xxx / 加了xxx库 / 依赖更新 / 装了新包 / 引入了新模块
  if (/新增.*(?:依赖|包|库|模块)|加了.*(?:包|库|依赖|模块)|引入.*(?:包|库|模块)|装了.*(?:新包|新库)|引入了.*(?:新|)模块|依赖.*(?:新增|更新|增加)|加了个.*(?:包|库)|引入.*(?:新|)包|新增.*(?:模块|包)|装了.*(?:依赖|库|包)|添加.*(?:依赖|包|库)|装.*(?:新|)依赖|加.*(?:新|)依赖|加入了.*(?:包|库)|require.*(?:新|)包|import.*(?:新|)模块|添加.*(?:新|)依赖|引入了.*(?:新|)依赖|npm.*add|pnpm.*add|yarn.*add|uv.*add|pip.*install|npm.*install|包.*(?:新增|添加|引入了)|库.*(?:新增|添加|引入了)/i.test(userMsg)) {
    return {
      id: `dep_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '依赖新增',
        action: 'dependency_added',
        source: 'sync',
        content: userMsg.slice(0, 100)
      },
      ttl_days: 60
    };
  }

  // ── Pattern 20: API/接口变更 ───────────────────────────────────────────
  // 匹配：接口改了 / API变更 / 改了接口 / 参数变了 / 接口文档更新 / 接口调整 / endpoint变更
  if (/接口.*(?:改|变更|更新|调整)|API.*(?:变更|更新|改了)|改了.*(?:接口|参数)|参数.*(?:变了|改了|调整了)|接口.*(?:文档|更新|变更)|endpoint.*(?:变|改|更新)|接口.*(?:变化|调整|重构)|请求.*(?:格式|结构).*(?:变了|改了)|接口.*重构|接口.*调整|接口.*重新|新的.*接口|接口.*换了|接口.*(?:新增|删除)|接口.*(?:废弃|弃用)|接口.*(?:升级|版本)|request.*(?:format|结构).*(?:变了|改)|response.*(?:format|结构).*(?:变了|改)|接口.*(?:签名|sign).*(?:变了|改)|调用.*(?:接口|API).*(?:改了|变了)|调用方式.*变了|接口调用.*更新|接口.*(?:改了|变化了)|接口.*(?:更新了|升级了)|新增.*接口|新接口|接口.*(?:上线|启用)/i.test(userMsg)) {
    return {
      id: `api_${dateStr}_${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      type: 'Event',
      properties: {
        name: '接口变更',
        action: 'api_changed',
        source: 'sync',
        content: userMsg.slice(0, 100)
      },
      ttl_days: 90
    };
  }

  return null;
}

// ─── 主 handler ───────────────────────────────────────────────────────────────

const handler = async (event) => {
  if (event.type !== 'message' || event.action !== 'preprocessed') return;

  const body = event.context && (
    event.context.bodyForAgent ||
    event.context.body ||
    event.context.content
  );
  if (!body || typeof body !== 'string' || body.trim().length < 2) return;

  // 1. 语义搜索
  let entities;
  try {
    entities = await semanticSearch(body.trim(), 8);
  } catch (err) {
    console.error('[ontology-recall] semanticSearch failed:', err.message);
    return;
  }

  if (!entities || !entities.length) return;

  // 2. 置信度调整 + 有效分数计算
  const withAdj = entities.map(e => ({
    ...e,
    adjustedConf: adjustConfidence(e),
    _effScore: effectiveScore(e)
  }));

  // 3. 过滤有效分数 > 0.12
  const filtered = withAdj.filter(e => e._effScore > 0.12);
  if (!filtered.length) return;

  // 4. 冲突检测与解决
  const { resolved, conflicts } = detectConflicts(filtered);
  const topIds = resolved.map(e => e.id);

  // 5. 异步更新访问元数据
  trackAccess(topIds).catch(err =>
    console.error('[ontology-recall] trackAccess failed:', err.message));

  // 6. 关系查询
  const needs2Hop = /关系|认识|连接|链路|chain|related|connection|通过|经过|path|route/i.test(body);
  const [directRels, hop2Rels] = await Promise.all([
    getDirectRelations(topIds).catch(() => []),
    needs2Hop ? get2HopRelations(topIds).catch(() => []) : Promise.resolve([])
  ]);

  // 7. 构建输出
  const lines = [];
  resolved.forEach(e => lines.push(`• ${formatEntity(e, true)}`));

  if (conflicts.length > 0) {
    lines.push('\n-- ⚠️ 冲突警告:');
    conflicts.forEach(c => {
      lines.push(`  • [${c.type}] ${c.winner.id} vs ${c.runnerUp.id} 相似度差${((c.winner.similarity-c.runnerUp.similarity)*100).toFixed(0)}%，已选用置信度最高`);
    });
  }

  if (directRels.length > 0) {
    lines.push('\n-- 直接关系:');
    const seen = new Set();
    directRels.forEach(r => {
      const key = `${r.from_id}->${r.to_id}`;
      if (!seen.has(key)) { seen.add(key); lines.push(`  • ${r.from_id} ${r.relation_type} ${r.to_id}`); }
    });
  }

  if (hop2Rels.length > 0) {
    lines.push('\n-- 2-hop 路径:');
    const seen = new Set();
    hop2Rels.forEach(r => {
      const key = `${r.from_id}->${r.mid_id}->${r.end_id}`;
      if (!seen.has(key)) { seen.add(key); lines.push(`  • ${r.from_id} -[${r.rel1}]-> ${r.mid_id} -[${r.rel2}]-> ${r.end_id}`); }
    });
  }

  // 8. sync：自动写入（v2 改进版，含去重）
  const autoSave = await extractAutoSave(body, '');
  if (autoSave) {
    await appendEntity(autoSave).catch(err =>
      console.error('[auto-sync] appendEntity failed:', err.message));
    lines.push(`\n-- 📝 已自动记录: ${autoSave.id} (${autoSave.type})`);
    console.log(`[auto-sync] saved: ${autoSave.id}`);
  }

  const recallText = `<graph-recall>\n${lines.join('\n')}\n</graph-recall>`;
  if (Array.isArray(event.messages)) {
    event.messages.push(recallText);
  }
};

export default handler;