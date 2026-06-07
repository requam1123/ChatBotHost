import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createJsonServer, HttpError } from './http.js';
import { JsonStore } from './storage.js';
import { ImClient } from './im-client.js';
import { getTemplate, listActiveTemplates } from './market.js';
import { executeToolCall, findTools, listTools, toolCatalog } from './tools.js';
import { generateAgentReply, testAgentProvider } from './providers.js';

const config = loadConfig();
const store = new JsonStore(config.storageDir);
const imClient = new ImClient(config.imServerBaseURL);

const routes = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    handler: async () => ({
      status: 'ok',
      service: 'ChatBotHost',
      imServerBaseURL: config.imServerBaseURL,
      time: Date.now(),
    }),
  },
  {
    method: 'GET',
    pattern: /^\/tools$/,
    handler: async ({ url }) => {
      const templateID = url.searchParams.get('agentTemplateID');
      const template = templateID ? requireTemplate(templateID) : undefined;
      return { tools: listTools({ template }), total: listTools({ template }).length };
    },
  },
  {
    method: 'GET',
    pattern: /^\/market\/agents$/,
    handler: async () => ({
      agents: listActiveTemplates().map((template) => ({
        ...template,
        tools: findTools(template.defaultToolIDs),
      })),
    }),
  },
  {
    method: 'GET',
    pattern: /^\/my\/agents$/,
    handler: async ({ url }) => {
      const ownerUserID = url.searchParams.get('ownerUserID');
      if (!ownerUserID) throw new HttpError(400, 'ownerUserID is required');

      const userAgents = await store.readCollection('user-agents');
      const agents = userAgents.filter((agent) => agent.ownerUserID === ownerUserID);
      return { agents, total: agents.length };
    },
  },
  {
    method: 'GET',
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)$/,
    handler: async ({ params }) => {
      const agent = await requireUserAgent(params.userAgentID);
      return { agent };
    },
  },
  {
    method: 'GET',
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)\/runs$/,
    handler: async ({ params, url }) => {
      await requireUserAgent(params.userAgentID);
      const limit = clampInteger(url.searchParams.get('limit'), 20, 1, 100);
      const runs = await store.readCollection('agent-runs');
      const filtered = runs
        .filter((run) => run.userAgentID === params.userAgentID)
        .sort((a, b) => (b.startTime || b.createTime || 0) - (a.startTime || a.createTime || 0));
      return { runs: filtered.slice(0, limit), total: filtered.length };
    },
  },
  {
    method: 'GET',
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)\/runs\/(?<runID>[^/]+)$/,
    handler: async ({ params }) => {
      await requireUserAgent(params.userAgentID);
      const runs = await store.readCollection('agent-runs');
      const run = runs.find((item) => item.userAgentID === params.userAgentID && item.runID === params.runID);
      if (!run) throw new HttpError(404, 'Run not found');
      return { run };
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)$/,
    handler: async ({ params, body }) => {
      const userAgents = await store.readCollection('user-agents');
      const index = userAgents.findIndex((item) => item.userAgentID === params.userAgentID);
      if (index === -1) throw new HttpError(404, 'Agent not found');

      const current = userAgents[index];
      const updates = sanitizeAgentUpdates(body);
      const agent = {
        ...current,
        ...updates,
        updateTime: Date.now(),
      };

      await imClient.registerAgentUser({
        userID: agent.imAgentUserID,
        nickname: agent.nickname,
        faceURL: agent.avatarURL,
        agentPrompt: agent.systemPrompt,
      });

      userAgents[index] = agent;
      await store.writeCollection('user-agents', userAgents);
      return { agent };
    },
  },
  {
    method: 'POST',
    pattern: /^\/market\/agents\/(?<templateID>[^/]+)\/add$/,
    handler: async ({ params, body }) => {
      const template = requireTemplate(params.templateID);
      const ownerUserID = requiredString(body.ownerUserID, 'ownerUserID');
      const now = Date.now();

      const userAgents = await store.readCollection('user-agents');
      const existing = userAgents.find(
        (agent) => agent.ownerUserID === ownerUserID && agent.templateID === template.templateID,
      );
      if (existing) return { agent: existing, created: false };

      const userAgentID = `ua_${randomUUID()}`;
      const imAgentUserID = `agent_${template.templateID}_${ownerUserID}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const agent = {
        userAgentID,
        ownerUserID,
        templateID: template.templateID,
        imAgentUserID,
        nickname: body.nickname || template.name,
        avatarURL: body.avatarURL || template.avatarURL,
        provider: body.provider || template.provider,
        endpoint: body.endpoint || template.defaultEndpoint || '',
        model: body.model || template.defaultModel,
        systemPrompt: body.systemPrompt || template.defaultSystemPrompt,
        secretRefID: body.secretRefID || '',
        enabledToolIDs: Array.isArray(body.enabledToolIDs) ? body.enabledToolIDs : template.defaultToolIDs,
        status: 'active',
        createTime: now,
        updateTime: now,
      };

      await imClient.registerAgentUser({
        userID: imAgentUserID,
        nickname: agent.nickname,
        faceURL: agent.avatarURL,
        agentPrompt: agent.systemPrompt,
      });
      await imClient.ensureFriendPair(ownerUserID, imAgentUserID);

      userAgents.push(agent);
      await store.writeCollection('user-agents', userAgents);

      return { agent, created: true };
    },
  },
  {
    method: 'POST',
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)\/test$/,
    handler: async ({ params, body }) => {
      const agent = await requireUserAgent(params.userAgentID);
      return testAgentProvider(config, agent, body);
    },
  },
  {
    method: 'POST',
    pattern: /^\/im\/events\/message$/,
    handler: async ({ body }) => {
      const event = parseMessageEvent(body);
      const userAgents = await store.readCollection('user-agents');
      const agent = userAgents.find((item) => item.imAgentUserID === event.recvID);
      if (!agent) throw new HttpError(404, `Agent binding not found: ${event.recvID}`);

      const runID = `run_${randomUUID()}`;
      void runMockAgentReply(runID, agent, event).catch((err) => {
        console.error('Mock agent reply failed', err);
      });

      return { accepted: true, runID };
    },
  },
  {
    method: 'GET',
    pattern: /^\/debug\/tool-catalog$/,
    handler: async () => ({ tools: toolCatalog }),
  },
];

const server = createJsonServer(routes);
server.listen(config.port, () => {
  console.log(`ChatBotHost listening on http://localhost:${config.port}`);
});

function requireTemplate(templateID) {
  const template = getTemplate(templateID);
  if (!template) throw new HttpError(404, `Agent template not found: ${templateID}`);
  return template;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${name} is required`);
  }
  return value.trim();
}

function parseMessageEvent(body) {
  return {
    conversationID: requiredString(body.conversationID, 'conversationID'),
    sendID: requiredString(body.sendID, 'sendID'),
    recvID: requiredString(body.recvID, 'recvID'),
    content: typeof body.content === 'string' ? body.content : '',
    serverMsgID: typeof body.serverMsgID === 'string' ? body.serverMsgID : '',
    contentType: typeof body.contentType === 'number' ? body.contentType : 101,
  };
}

async function runMockAgentReply(runID, agent, event) {
  const startTime = Date.now();
  const result = await buildAgentReply(agent, event);
  const replyText = result.content;
  const initial = '正在思考...';
  const sent = await imClient.sendMessage({
    sendID: agent.imAgentUserID,
    recvID: event.sendID,
    content: initial,
    senderNickname: agent.nickname,
    senderFaceURL: agent.avatarURL,
  });

  const serverMsgID = sent.serverMsgID;
  if (!serverMsgID) throw new Error('IM send_msg did not return serverMsgID');

  let current = '';
  for (const part of chunkText(replyText, 4)) {
    current += part;
    await delay(70);
    await imClient.patchMessage(serverMsgID, current, false);
  }
  await imClient.patchMessage(serverMsgID, replyText, true);

  const runs = await store.readCollection('agent-runs');
  const endTime = Date.now();
  runs.push({
    runID,
    userAgentID: agent.userAgentID,
    imAgentUserID: agent.imAgentUserID,
    ownerUserID: agent.ownerUserID,
    conversationID: event.conversationID,
    requestServerMsgID: event.serverMsgID,
    responseServerMsgID: serverMsgID,
    status: result.status,
    mode: result.mode,
    provider: result.provider,
    endpoint: result.endpoint,
    model: result.model,
    input: {
      sendID: event.sendID,
      recvID: event.recvID,
      content: event.content,
      contentType: event.contentType,
      serverMsgID: event.serverMsgID,
    },
    output: {
      sendID: agent.imAgentUserID,
      recvID: event.sendID,
      content: replyText,
      serverMsgID,
    },
    toolCalls: result.toolCalls,
    error: result.error,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    createTime: endTime,
  });
  await store.writeCollection('agent-runs', runs);
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildAgentReply(agent, event) {
  try {
    const result = await generateAgentReply(config, agent, event, {
      toolExecutor: (toolID, args, context) => executeToolCall(toolID, args, {
        ...context,
        imClient,
        enabledToolIDs: agent.enabledToolIDs || [],
      }),
    });
    return { ...result, mode: 'provider', status: 'success', error: '' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Provider completion failed';
    console.error('Provider completion failed, falling back to mock reply', message);
    return {
      content: `${agent.nickname} 暂时无法连接模型，已收到你的消息：${event.content}`,
      mode: 'fallback',
      status: 'failed',
      provider: agent.provider || '',
      endpoint: agent.endpoint || '',
      model: agent.model || '',
      toolCalls: [],
      error: message,
    };
  }
}

function clampInteger(value, defaultValue, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

async function requireUserAgent(userAgentID) {
  const userAgents = await store.readCollection('user-agents');
  const agent = userAgents.find((item) => item.userAgentID === userAgentID);
  if (!agent) throw new HttpError(404, 'Agent not found');
  return agent;
}

function sanitizeAgentUpdates(body) {
  const updates = {};
  for (const key of ['nickname', 'avatarURL', 'provider', 'endpoint', 'model', 'systemPrompt']) {
    if (typeof body[key] === 'string') updates[key] = body[key].trim();
  }
  if (Array.isArray(body.enabledToolIDs)) {
    const validIDs = new Set(listTools().map((tool) => tool.toolID));
    updates.enabledToolIDs = body.enabledToolIDs.filter((id) => typeof id === 'string' && validIDs.has(id));
  }
  return updates;
}
