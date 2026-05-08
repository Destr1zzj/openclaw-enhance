import fs = require('fs');
import path = require('path');

interface AgentBootstrapEvent {
  type: "agent";
  action: "bootstrap";
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context: {
    bootstrapFiles?: Array<{ path: string; content: string }>;
    workspaceDir?: string;
    cfg?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

const {
  loadGraphLines,
  getGraphStats,
  summarizeEntity
} = require('../../workspace/memory/ontology/graph_ops').GraphOperations;

const handler = async (event: AgentBootstrapEvent): Promise<void> => {
  const workspaceDir = event.context.workspaceDir as string | undefined;
  if (!workspaceDir) return;

  const graphOpsPath = path.join(workspaceDir, 'memory/ontology/graph_ops.js');

  // Check module exists
  try { require.resolve(graphOpsPath); } catch { return; }

  // Try to load and use graph_ops
  let graphSummary = '';
  try {
    const { GraphOperations } = require(graphOpsPath);
    const lines = GraphOperations.loadGraphLines();
    const stats = GraphOperations.getGraphStats();

    // Build a compact summary of all entities
    const entities = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.op === 'delete') continue;
        const entity = parsed.entity || parsed;
        entities.push(entity);
      } catch { /* skip */ }
    }

    // Summarize each entity into a one-liner
    const summaries = entities
      .map(e => `• [${e.type || '?'}] ${GraphOperations.summarizeEntity(e)}`)
      .join('\n');

    graphSummary = `
\`\`\`知识图谱摘要 (${stats.count} 条实体, 最后更新: ${stats.lastUpdated || '无'})
\`\`\`
${summaries}
\`\`\`
`;
  } catch (err) {
    // Failed to load graph — show warning
    graphSummary = `\n⚠️ [ontology-bootstrap] 图谱加载失败: ${err instanceof Error ? err.message : String(err)}\n`;
  }

  if (!graphSummary) return;

  // Inject into bootstrap files — find SOUL.md and prepend
  const bootstrapFiles = event.context.bootstrapFiles;
  if (bootstrapFiles && bootstrapFiles.length > 0) {
    const soulFile = bootstrapFiles.find((f) => f.path.endsWith("SOUL.md"));
    if (soulFile) {
      soulFile.content = graphSummary + '\n---\n' + soulFile.content;
    }
  }
};

export default handler;