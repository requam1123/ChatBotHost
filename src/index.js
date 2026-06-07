import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createJsonServer, HttpError } from './http.js';
import { JsonStore } from './storage.js';
import { ImClient } from './im-client.js';
import { getTemplate, listActiveTemplates } from './market.js';
import { executeToolCall, findTools, listTools, toolCatalog } from './tools.js';
import { generateAgentReply, testAgentProvider } from './providers.js';
import { createLangGraphRuntime } from './langgraph-runtime.js';

const config = loadConfig();
const store = new JsonStore(config.storageDir);
const imClient = new ImClient(config.imServerBaseURL);
const langGraphRuntime = await createLangGraphRuntime();

const routes = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    handler: async () => ({
      status: 'ok',
      service: 'ChatBotHost',
      imServerBaseURL: config.imServerBaseURL,
      langGraphRuntime: {
        available: langGraphRuntime.available,
        source: langGraphRuntime.source,
        error: langGraphRuntime.error || '',
      },
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
        runtime: body.runtime || template.defaultRuntime || 'openai-tools',
        workerTemplateID: body.workerTemplateID || template.defaultWorkerTemplateID || 'coder',
        workerAgentUserID: body.workerAgentUserID || '',
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
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)\/graph\/delegate-test$/,
    handler: async ({ params, body }) => {
      if (!langGraphRuntime.available || !langGraphRuntime.runPlannerWorkerGraph) {
        throw new HttpError(503, 'LangGraph runtime is not available');
      }

      const plannerAgent = await requireUserAgent(params.userAgentID);
      const workerAgent = await requireWorkerAgent(plannerAgent, body);
      const task = requiredString(body.task, 'task');
      const event = {
        conversationID: typeof body.conversationID === 'string' && body.conversationID.trim()
          ? body.conversationID.trim()
          : `graph_${plannerAgent.userAgentID}`,
        sendID: plannerAgent.ownerUserID,
        recvID: plannerAgent.imAgentUserID,
        content: task,
        serverMsgID: '',
        contentType: 101,
      };

      const startTime = Date.now();
      const result = await langGraphRuntime.runPlannerWorkerGraph({
        task,
        context: typeof body.context === 'string' ? body.context : '',
        plannerAgent,
        workerAgent,
        event,
        generateReply: (agent, nextEvent) => buildGraphNodeReply(agent, nextEvent),
      });

      return {
        runtime: 'langgraph',
        durationMs: Date.now() - startTime,
        plannerAgentID: plannerAgent.userAgentID,
        workerAgentID: workerAgent.userAgentID,
        task,
        workerOutput: result.workerOutput,
        finalOutput: result.finalOutput,
        steps: result.steps,
      };
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
  const result = await buildAgentReplyForRuntime(agent, event, {
    runID,
    rootRunID: runID,
    parentRunID: '',
    depth: 0,
    allowDelegate: true,
  });
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
  runs.push(buildRunRecord({
    runID,
    responseServerMsgID: serverMsgID,
    output: {
      sendID: agent.imAgentUserID,
      recvID: event.sendID,
      content: replyText,
      serverMsgID,
    },
    agent,
    event,
    result,
    startTime,
    endTime,
  }));
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

async function buildAgentReplyForRuntime(agent, event, runContext = {}) {
  if (agent.runtime === 'langgraph-planner-worker') {
    return buildLangGraphAgentReply(agent, event, runContext);
  }
  return buildAgentReply(agent, event, runContext);
}

async function buildAgentReply(agent, event, runContext = {}) {
  try {
    const result = await generateAgentReply(config, agent, event, {
      toolExecutor: (toolID, args, context) => executeToolCall(toolID, args, {
        ...context,
        imClient,
        runContext,
        enabledToolIDs: agent.enabledToolIDs || [],
        delegateToAgent: (delegation) => delegateToAgent(agent, event, runContext, delegation),
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

async function buildLangGraphAgentReply(agent, event) {
  if (!langGraphRuntime.available || !langGraphRuntime.runPlannerWorkerGraph) {
    throw new Error('LangGraph runtime is not available');
  }

  const workerAgent = await requireWorkerAgent(agent, {
    agentUserID: agent.workerAgentUserID || '',
    templateID: agent.workerTemplateID || 'coder',
  });
  const result = await langGraphRuntime.runPlannerWorkerGraph({
    task: event.content,
    context: `IM conversation: ${event.conversationID}`,
    plannerAgent: agent,
    workerAgent,
    event,
    generateReply: (nextAgent, nextEvent) => buildGraphNodeReply(nextAgent, nextEvent),
  });

  return {
    content: result.finalOutput,
    mode: 'langgraph',
    runtime: 'langgraph-planner-worker',
    status: 'success',
    provider: result.steps.find((step) => step.provider)?.provider || agent.provider || '',
    endpoint: result.steps.find((step) => step.endpoint)?.endpoint || agent.endpoint || '',
    model: result.steps.find((step) => step.model)?.model || agent.model || '',
    toolCalls: [],
    error: '',
    graphSteps: result.steps,
    workerAgentID: workerAgent.userAgentID,
    workerAgentUserID: workerAgent.imAgentUserID,
    workerTemplateID: workerAgent.templateID,
    workerOutput: result.workerOutput,
    finalOutput: result.finalOutput,
  };
}

async function delegateToAgent(sourceAgent, event, runContext, delegation) {
  if (!runContext.allowDelegate || runContext.depth >= 1) {
    return { ok: false, error: 'Delegation depth limit reached' };
  }

  const userAgents = await store.readCollection('user-agents');
  const targetAgent = findDelegationTarget(userAgents, sourceAgent, delegation);
  if (!targetAgent) {
    return { ok: false, error: 'No eligible target agent found for delegation' };
  }

  const childRunID = `run_${randomUUID()}`;
  const childEvent = {
    conversationID: event.conversationID,
    sendID: sourceAgent.imAgentUserID,
    recvID: targetAgent.imAgentUserID,
    content: buildDelegationContent(delegation),
    serverMsgID: '',
    contentType: 101,
  };
  const startTime = Date.now();
  const result = await buildAgentReply(targetAgent, childEvent, {
    runID: childRunID,
    rootRunID: runContext.rootRunID || runContext.runID,
    parentRunID: runContext.runID,
    depth: runContext.depth + 1,
    allowDelegate: false,
    delegatedByAgentID: sourceAgent.userAgentID,
    delegatedToAgentID: targetAgent.userAgentID,
    delegationTask: delegation.task,
  });
  const endTime = Date.now();

  const runs = await store.readCollection('agent-runs');
  runs.push(buildRunRecord({
    runID: childRunID,
    parentRunID: runContext.runID,
    rootRunID: runContext.rootRunID || runContext.runID,
    runType: 'delegated',
    delegatedByAgentID: sourceAgent.userAgentID,
    delegatedToAgentID: targetAgent.userAgentID,
    delegationTask: delegation.task,
    responseServerMsgID: '',
    output: {
      sendID: targetAgent.imAgentUserID,
      recvID: sourceAgent.imAgentUserID,
      content: result.content,
      serverMsgID: '',
    },
    agent: targetAgent,
    event: childEvent,
    result,
    startTime,
    endTime,
  }));
  await store.writeCollection('agent-runs', runs);

  return {
    ok: result.status === 'success',
    childRunID,
    delegatedToAgentID: targetAgent.userAgentID,
    delegatedToAgentUserID: targetAgent.imAgentUserID,
    delegatedToTemplateID: targetAgent.templateID,
    task: delegation.task,
    output: result.content,
    durationMs: endTime - startTime,
    error: result.error || '',
  };
}

function findDelegationTarget(userAgents, sourceAgent, delegation) {
  const candidates = userAgents.filter((agent) => (
    agent.ownerUserID === sourceAgent.ownerUserID &&
    agent.userAgentID !== sourceAgent.userAgentID &&
    agent.status !== 'disabled'
  ));
  if (delegation.agentUserID) {
    return candidates.find((agent) => (
      agent.imAgentUserID === delegation.agentUserID ||
      agent.userAgentID === delegation.agentUserID
    ));
  }
  if (delegation.templateID) {
    return candidates.find((agent) => agent.templateID === delegation.templateID);
  }
  return candidates[0];
}

function buildDelegationContent(delegation) {
  if (!delegation.context) return delegation.task;
  return `${delegation.task}\n\nContext:\n${delegation.context}`;
}

function buildRunRecord({
  runID,
  parentRunID = '',
  rootRunID = runID,
  runType = 'chat',
  delegatedByAgentID = '',
  delegatedToAgentID = '',
  delegationTask = '',
  responseServerMsgID,
  output,
  agent,
  event,
  result,
  startTime,
  endTime,
}) {
  const childrenRunIDs = (result.toolCalls || [])
    .map((call) => call.result?.childRunID)
    .filter(Boolean);
  return {
    runID,
    parentRunID,
    rootRunID,
    runType,
    delegatedByAgentID,
    delegatedToAgentID,
    delegationTask,
    childrenRunIDs,
    userAgentID: agent.userAgentID,
    imAgentUserID: agent.imAgentUserID,
    ownerUserID: agent.ownerUserID,
    conversationID: event.conversationID,
    requestServerMsgID: event.serverMsgID,
    responseServerMsgID,
    status: result.status,
    mode: result.mode,
    runtime: result.runtime || agent.runtime || 'openai-tools',
    provider: result.provider,
    endpoint: result.endpoint,
    model: result.model,
    graphSteps: result.graphSteps || [],
    workerAgentID: result.workerAgentID || '',
    workerAgentUserID: result.workerAgentUserID || '',
    workerTemplateID: result.workerTemplateID || '',
    workerOutput: result.workerOutput || '',
    finalOutput: result.finalOutput || output.content,
    input: {
      sendID: event.sendID,
      recvID: event.recvID,
      content: event.content,
      contentType: event.contentType,
      serverMsgID: event.serverMsgID,
    },
    output,
    toolCalls: result.toolCalls,
    error: result.error,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    createTime: endTime,
  };
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

async function requireWorkerAgent(plannerAgent, body) {
  const userAgents = await store.readCollection('user-agents');
  const worker = findDelegationTarget(userAgents, plannerAgent, {
    agentUserID: typeof body.agentUserID === 'string' ? body.agentUserID.trim() : '',
    templateID: typeof body.templateID === 'string' ? body.templateID.trim() : 'coder',
  });
  if (!worker) throw new HttpError(404, 'Worker agent not found');
  return worker;
}

async function buildGraphNodeReply(agent, event) {
  const result = await generateAgentReply(config, {
    ...agent,
    enabledToolIDs: [],
  }, event, {});
  return { ...result, mode: 'langgraph', status: 'success', error: '' };
}

function sanitizeAgentUpdates(body) {
  const updates = {};
  for (const key of [
    'nickname',
    'avatarURL',
    'provider',
    'endpoint',
    'model',
    'systemPrompt',
    'runtime',
    'workerTemplateID',
    'workerAgentUserID',
  ]) {
    if (typeof body[key] === 'string') updates[key] = body[key].trim();
  }
  if (updates.runtime && !['openai-tools', 'langgraph-planner-worker'].includes(updates.runtime)) {
    delete updates.runtime;
  }
  if (Array.isArray(body.enabledToolIDs)) {
    const validIDs = new Set(listTools().map((tool) => tool.toolID));
    updates.enabledToolIDs = body.enabledToolIDs.filter((id) => typeof id === 'string' && validIDs.has(id));
  }
  return updates;
}
