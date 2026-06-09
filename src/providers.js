import { findTools, toOpenAITools } from './tools.js';
import { createLogger } from './logger.js';

const log = createLogger('provider');

export async function generateAgentReply(config, agent, event, options = {}) {
  const providerConfig = resolveProviderConfig(config, agent);
  if (providerConfig.apiKey && providerConfig.model) {
    log.info(`调用 LLM: provider=${providerConfig.provider}, model=${providerConfig.model}, endpoint=${providerConfig.baseURL}`);
    const result = await callOpenAICompatible(providerConfig, agent, event, options);
    log.info(`LLM 回复成功: provider=${providerConfig.provider}, contentLength=${result.content?.length || 0}, toolCalls=${result.toolCalls?.length || 0}`);
    return {
      ...result,
      provider: providerConfig.provider,
      endpoint: providerConfig.baseURL,
      model: providerConfig.model,
    };
  }
  log.info(`LLM 未配置，使用 mock 回复: agent=${agent.nickname || agent.templateID}`);
  return {
    content: buildMockReply(agent, event),
    toolCalls: [],
    provider: providerConfig.provider,
    endpoint: providerConfig.baseURL,
    model: providerConfig.model,
  };
}

export async function testAgentProvider(config, agent, overrides = {}) {
  const providerConfig = resolveProviderConfig(config, { ...agent, ...overrides });
  if (!providerConfig.apiKey || !providerConfig.model) {
    return {
      ok: false,
      provider: providerConfig.provider,
      endpoint: providerConfig.baseURL,
      model: providerConfig.model,
      message: 'Missing provider API key or model.',
    };
  }

  try {
    const result = await callOpenAICompatible(providerConfig, {
      systemPrompt: 'Answer with one short sentence.',
      enabledToolIDs: [],
    }, {
      content: 'Say hello.',
    });

    return {
      ok: true,
      provider: providerConfig.provider,
      endpoint: providerConfig.baseURL,
      model: providerConfig.model,
      message: result.content,
    };
  } catch (err) {
    return {
      ok: false,
      provider: providerConfig.provider,
      endpoint: providerConfig.baseURL,
      model: providerConfig.model,
      message: err instanceof Error ? err.message : 'Provider test failed.',
    };
  }
}

export function resolveProviderConfig(config, agent) {
  const provider = agent.provider || 'ark';
  const endpoint = agent.endpoint || '';

  if (
    provider === 'ark' ||
    endpoint.includes('volces.com') ||
    agent.model?.startsWith?.('ep-') ||
    config.ark.apiKey?.startsWith?.('ark-')
  ) {
    return {
      provider: 'ark',
      baseURL: endpoint.includes('volces.com') ? endpoint : config.ark.baseURL,
      apiKey: config.ark.apiKey,
      model: agent.model || config.ark.model,
    };
  }

  return {
    provider,
    baseURL: endpoint,
    apiKey: config.ark.apiKey,
    model: agent.model,
  };
}

async function callOpenAICompatible(providerConfig, agent, event, options = {}) {
  const enabledTools = findTools(agent.enabledToolIDs || []);
  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt(agent, enabledTools),
    },
    {
      role: 'user',
      content: event.content,
    },
  ];
  const toolCalls = [];

  for (let step = 0; step < 3; step += 1) {
    log.info(`LLM 第 ${step + 1} 轮请求, toolCall 累计=${toolCalls.length}`);
    const payload = await requestChatCompletion(providerConfig, messages, enabledTools);
    const message = payload?.choices?.[0]?.message;
    if (!message) throw new Error('Provider response did not include a message');

    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      const content = message.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('Provider response did not include message content');
      }
      log.info(`LLM 返回纯文本回复, 长度=${content.length}`);
      return { content: content.trim(), toolCalls };
    }

    log.info(`LLM 返回 ${message.tool_calls.length} 个 tool_calls: [${message.tool_calls.map((tc) => tc?.function?.name).join(', ')}]`);

    messages.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: message.tool_calls,
    });

    for (const toolCall of message.tool_calls) {
      const name = toolCall?.function?.name;
      const args = parseToolArguments(toolCall?.function?.arguments);
      const result = await executeToolCall(name, args, agent, event, options);
      toolCalls.push({
        toolCallID: toolCall.id,
        toolID: name,
        args,
        result,
        createTime: Date.now(),
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  log.warn(`LLM 超过最大 tool-call 轮次 (3)`);
  throw new Error('Provider exceeded maximum tool-call steps');
}

async function requestChatCompletion(providerConfig, messages, enabledTools) {
  const body = {
    model: providerConfig.model,
    messages,
  };
  if (enabledTools.length > 0) {
    body.tools = toOpenAITools(enabledTools);
    body.tool_choice = 'auto';
  }

  const url = `${providerConfig.baseURL.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${providerConfig.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = payload?.error?.message || `Provider request failed with ${res.status}`;
    log.error(`LLM API 请求失败: ${url} -> ${res.status}, ${errMsg}`);
    throw new Error(errMsg);
  }

  const usage = payload?.usage;
  if (usage) {
    log.info(`LLM 响应: status=${res.status}, tokens(prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens})`);
  }
  return payload;
}

async function executeToolCall(toolID, args, agent, event, options) {
  if (!options.toolExecutor) {
    return { ok: false, error: 'Tool executor is not available' };
  }
  if (typeof toolID !== 'string' || !toolID.trim()) {
    return { ok: false, error: 'Tool call did not include a function name' };
  }
  return options.toolExecutor(toolID, args, { agent, event });
}

function parseToolArguments(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildSystemPrompt(agent, enabledTools) {
  const base = agent.systemPrompt || 'You are a helpful assistant.';
  if (enabledTools.length === 0) return base;
  return `${base}

You may call the provided tools when they are useful. Use get_current_time for current time questions. Use read_conversation_messages only when conversation context is needed. Use delegate_to_agent when a task should be handled by a more suitable specialist agent; prefer templateID such as "coder", "planner", or "chatgpt" if the exact agentUserID is unknown. After a delegated agent returns, synthesize the result into your final answer. Do not call send_im_message unless the user explicitly asks you to send a separate IM message; normal answers should be returned as assistant text.`;
}

function buildMockReply(agent, event) {
  const text = event.content.trim() || '空消息';
  return `${agent.nickname} 已收到：${text}\n\n这是 ChatBotHost 的 mock 流式回复。下一步会把这里替换成 LangChain Agent 运行结果。`;
}
