import { createLogger } from './logger.js';

const log = createLogger('mcp');

export async function discoverMcpTools(url) {
  const baseUrl = url.replace(/\/$/, '');

  log.info(`发现 MCP 工具: ${baseUrl}`);
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  });

  if (!res.ok) {
    throw new Error(`MCP tools/list failed: HTTP ${res.status}`);
  }

  const payload = await res.json();
  if (payload.error) {
    throw new Error(payload.error.message || 'MCP tools/list returned an error');
  }

  const tools = Array.isArray(payload.result?.tools) ? payload.result.tools : [];
  const parsed = tools.map((t) => ({
    toolID: String(t.name || ''),
    name: String(t.name || ''),
    description: String(t.description || ''),
    inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
  }));

  log.info(`MCP 工具发现完成: ${baseUrl}, ${parsed.length} 个工具`);
  return parsed;
}

export async function executeMcpTool(url, toolID, args = {}) {
  const baseUrl = url.replace(/\/$/, '');

  log.info(`执行 MCP 工具: ${toolID} @ ${baseUrl}`);
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: toolID,
        arguments: args,
      },
      id: 2,
    }),
  });

  if (!res.ok) {
    return { ok: false, error: `MCP tools/call failed: HTTP ${res.status}` };
  }

  const payload = await res.json();
  if (payload.error) {
    return { ok: false, error: payload.error.message || 'MCP tools/call returned an error' };
  }

  const result = payload.result;
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    const textParts = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { ok: true, content: textParts, raw: result };
  }

  return { ok: true, content: typeof result === 'string' ? result : JSON.stringify(result), raw: result };
}

export function mcpToolId(mcpConnectionID, toolID) {
  return `mcp:${mcpConnectionID}:${toolID}`;
}

export function parseMcpToolId(prefixedId) {
  if (!prefixedId.startsWith('mcp:')) return null;
  const parts = prefixedId.split(':');
  if (parts.length < 3) return null;
  return { mcpConnectionID: parts[1], toolID: parts.slice(2).join(':') };
}
