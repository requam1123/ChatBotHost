import { randomUUID } from 'node:crypto';
import { createAgent, tool } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { executeToolCall, findTools } from './tools.js';
import { resolveProviderConfig } from './providers.js';
import { createLogger } from './logger.js';

const log = createLogger('langchain');

const toolSchemas = {
  get_current_time: z.object({}),
  read_conversation_messages: z.object({
    conversationID: z.string().optional(),
    limit: z.number().min(1).max(100).optional(),
  }),
  send_im_message: z.object({
    conversationID: z.string(),
    content: z.string(),
  }),
  delegate_to_agent: z.object({
    agentUserID: z.string().optional(),
    templateID: z.string().optional(),
    task: z.string(),
    context: z.string().optional(),
  }),
  workspace_read: z.object({
    path: z.string(),
    maxChars: z.number().min(1000).max(100000).optional(),
  }),
  workspace_write: z.object({
    path: z.string(),
    content: z.string(),
  }),
  bash: z.object({
    command: z.string(),
    cwd: z.string().optional(),
    timeoutMs: z.number().min(1000).max(30000).optional(),
  }),
};

export async function generateLangChainAgentReply(store, agent, event, options = {}) {
  const providerConfig = await resolveProviderConfig(store, agent);
  if (!providerConfig.apiKey || !providerConfig.model) {
    throw new Error('Missing provider API key or model.');
  }

  log.info(`LangChain Agent 开始: agent=${agent.nickname || agent.templateID}, model=${providerConfig.model}`);
  const toolCalls = [];
  const enabledTools = buildLangChainTools(store, agent, event, options, toolCalls);
  const model = new ChatOpenAI({
    model: providerConfig.model,
    apiKey: providerConfig.apiKey,
    temperature: 0,
    configuration: {
      baseURL: providerConfig.baseURL,
    },
  });

  const runtime = createAgent({
    model,
    tools: enabledTools,
    systemPrompt: buildSystemPrompt(agent, enabledTools),
    name: agent.templateID || agent.nickname || 'agent',
  });

  let result;
  try {
    result = await runtime.invoke(
      {
        messages: [
          { role: 'user', content: event.content || '' },
        ],
      },
      {
        recursionLimit: 10,
        configurable: {
          thread_id: event.conversationID || options.runID || randomUUID(),
        },
        metadata: {
          runID: options.runID || '',
          userAgentID: agent.userAgentID || '',
          imAgentUserID: agent.imAgentUserID || '',
        },
      },
    );
    log.info(`LangChain Agent 完成: toolCalls=${toolCalls.length}`);
  } catch (err) {
    if (toolCalls.length === 0) {
      log.error(`LangChain Agent 执行失败 (无 toolCalls)`, err);
      throw err;
    }
    const message = err instanceof Error ? err.message : 'LangChain agent stopped after tool execution';
    log.warn(`LangChain Agent 异常但已执行 toolCalls: ${message}, toolCalls=${toolCalls.length}`);
    return {
      content: summarizeToolCalls(toolCalls, message),
      mode: 'langchain-agent',
      runtime: 'langchain-agent',
      status: 'success',
      provider: providerConfig.provider,
      endpoint: providerConfig.baseURL,
      model: providerConfig.model,
      toolCalls,
      error: message,
    };
  }

  return {
    content: extractFinalContent(result),
    mode: 'langchain-agent',
    runtime: 'langchain-agent',
    status: 'success',
    provider: providerConfig.provider,
    endpoint: providerConfig.baseURL,
    model: providerConfig.model,
    toolCalls,
    error: '',
  };
}

function buildLangChainTools(store, agent, event, options, toolCalls) {
  const enabledToolDefs = findTools(agent.enabledToolIDs || []);
  return enabledToolDefs.map((toolDef) => tool(async (args) => {
    const startTime = Date.now();
    const result = await executeToolCall(toolDef.toolID, args, {
      agent,
      event,
      imClient: options.imClient,
      enabledToolIDs: agent.enabledToolIDs || [],
      delegateToAgent: options.delegateToAgent,
      workspaceRoot: store.config?.workspaceRoot || '',
      runID: options.runID,
      workspaceID: options.workspaceID,
      workspacePath: options.workspacePath,
    });
    toolCalls.push({
      toolCallID: `tool_${randomUUID()}`,
      toolID: toolDef.toolID,
      args: safeRecord(args),
      result: safeRecord(result),
      startTime,
      createTime: Date.now(),
      durationMs: Date.now() - startTime,
    });
    return JSON.stringify(result);
  }, {
    name: toolDef.toolID,
    description: toolDef.description,
    schema: toolSchemas[toolDef.toolID] || z.object({}),
  }));
}

function buildSystemPrompt(agent, enabledTools) {
  const base = agent.systemPrompt || 'You are a helpful assistant.';
  if (enabledTools.length === 0) return base;
  return `${base}

You are running as a LangChain agent with real tools. Use tools when they are useful and report what you did. For coding tasks, prefer this concrete loop:
1. Use workspace_write to create or edit files in your sandbox.
2. Use workspace_read when you need to inspect files.
3. Use bash to run a small verification command.
4. Return a concise final answer with files touched, commands run, and results.

Do not claim you executed a command unless you called the bash tool. Do not claim you wrote a file unless you called workspace_write.`;
}

function extractFinalContent(result) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const last = [...messages].reverse().find((message) => {
    const content = message?.content;
    return typeof content === 'string' && content.trim()
      || Array.isArray(content) && content.length > 0;
  });
  const content = last?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === 'string' ? part : part?.text || part?.content || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return 'Agent completed without a text response.';
}

function summarizeToolCalls(toolCalls, warning) {
  const lines = [
    '工具调用已执行，但模型没有在限定步数内生成最终自然语言答复。我保留了真实工具轨迹：',
    '',
  ];
  for (const call of toolCalls) {
    const result = call.result || {};
    if (call.toolID === 'workspace_write') {
      lines.push(`- workspace_write: ${result.path || call.args?.path || ''} (${result.bytes ?? '-'} bytes)`);
    } else if (call.toolID === 'workspace_read') {
      lines.push(`- workspace_read: ${result.path || call.args?.path || ''} (${result.bytes ?? '-'} bytes, truncated=${Boolean(result.truncated)})`);
    } else if (call.toolID === 'bash') {
      lines.push(`- bash: ${result.command || call.args?.command || ''} -> exit ${result.exitCode ?? '-'}${result.stdout ? `, stdout: ${String(result.stdout).trim()}` : ''}`);
    } else {
      lines.push(`- ${call.toolID}: ok=${result.ok}`);
    }
  }
  lines.push('', `注意：${warning}`);
  return lines.join('\n');
}

function safeRecord(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return { value };
}
