import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createJsonServer, HttpError } from './http.js';
import { JsonStore } from './storage.js';
import { ImClient } from './im-client.js';
import { ImWsClient } from './im-ws-client.js';
import { getTemplate, listActiveTemplates } from './market.js';
import { testAgentProvider } from './providers.js';
import { createLangGraphRuntime } from './langgraph-runtime.js';
import { discoverMcpTools } from './mcp-client.js';
import { findTools, listTools, toolCatalog } from './tools.js';
import { applyPatchProposal, createPatchPreview } from './patch-manager.js';
import { createLangGraphSupervisorRuntime } from './langgraph-supervisor-runtime.js';
import {
  normalizeArtifacts,
  normalizeApprovals,
} from './run-records.js';
import {
  bindConversationWorkspace,
  createWorkspace,
  getConversationWorkspace,
  listWorkspaceFiles,
  listWorkspaces,
  readWorkspaceFile,
  requireWorkspace,
  writeWorkspaceFile,
} from './workspace-manager.js';
import { listLocalDirectories } from './filesystem.js';
import {
  initReplyServices,
  runMockAgentReply,
  buildGraphNodeReply,
  requireWorkerAgent,
  truncateText,
} from './agent-reply.js';
import {
  initGroupCollaborationServices,
  handleGroupPlanConfirmation,
  runVisibleGroupCollaboration,
  sendGroupCollaborationError,
} from './group-collaboration.js';
import { seedData } from './seed.js';

const config = loadConfig();
const store = new JsonStore(config.storageDir);
const imClient = new ImClient(config.imServerBaseURL);
const log = createLogger('server');
const langGraphRuntime = await createLangGraphRuntime();
const langGraphSupervisorRuntime = await createLangGraphSupervisorRuntime();

initReplyServices({ store, imClient, config, langGraphRuntime });
initGroupCollaborationServices({ store, imClient, langGraphSupervisorRuntime });

const wsConnections = new Map();

async function connectAgentWs(agent) {
  if (!agent.imAgentUserID) return;
  const existing = wsConnections.get(agent.imAgentUserID);
  if (existing) {
    log.info(`断开旧的 WS 连接: ${agent.imAgentUserID}`);
    existing.disconnect();
  }

  const token = await imClient.getToken(agent.imAgentUserID, 12);
  log.info(`建立 WS 连接: ${agent.imAgentUserID}`);
  const client = new ImWsClient({
    wsURL: config.imServerWSURL,
    agentUserID: agent.imAgentUserID,
    token,
    platformID: 12,
    onMessage: (payload) => {
      void handleIncomingMessage(payload).catch((err) => {
        log.error('WS 消息处理失败', err);
      });
    },
  });
  wsConnections.set(agent.imAgentUserID, client);
  client.connect();
}

async function startAgentWsConnections() {
  const userAgents = await store.readCollection('agents');
  log.info(`启动 ${userAgents.length} 个 Agent WebSocket 连接`);
  for (const agent of userAgents) {
    await connectAgentWs(agent);
  }
  log.info(`WebSocket 连接完成: ${wsConnections.size} 个`);
}

async function handleIncomingMessage(payload) {
  const msgData = payload.msgData || payload;
  const conversationID = payload.conversationID || msgData.conversationID || '';

  const event = {
    conversationID,
    sendID: msgData.sendID || '',
    recvID: msgData.recvID || '',
    groupID: msgData.groupID || '',
    content: msgData.content || '',
    serverMsgID: msgData.serverMsgID || '',
    contentType: msgData.contentType || 101,
    sessionType: msgData.sessionType || 1,
    atUserIDList: Array.isArray(msgData.atUserIDList) ? msgData.atUserIDList : [],
    mentionedAgentIDs: [],
  };

  const userAgents = await store.readCollection('agents');
  const agent = userAgents.find((item) => item.imAgentUserID === event.recvID);
  if (!agent) {
    log.warn(`未找到 Agent 绑定: recvID=${event.recvID}`);
    return;
  }

  log.info(`收到 IM 消息: from=${event.sendID}, to=${event.recvID}(${agent.nickname || agent.templateID}), conversation=${event.conversationID}, content="${truncateText(event.content, 80)}"`);

  const runID = `run_${randomUUID()}`;
  void runMockAgentReply(runID, agent, event, {
    handleGroupPlanConfirmation,
    runVisibleGroupCollaboration,
    sendGroupCollaborationError,
  }).catch((err) => {
    log.error(`Agent 回复失败: agent=${agent.nickname || agent.templateID}, runID=${runID}`, err);
  });
}

void startAgentWsConnections();

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
      langGraphSupervisorRuntime: {
        available: langGraphSupervisorRuntime.available,
        source: langGraphSupervisorRuntime.source,
        error: langGraphSupervisorRuntime.error || '',
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
    pattern: /^\/workspaces$/,
    handler: async ({ url }) => {
      const ownerUserID = requiredString(url.searchParams.get('ownerUserID'), 'ownerUserID');
      const workspaces = await listWorkspaces({ store, ownerUserID });
      return { workspaces, total: workspaces.length };
    },
  },
  {
    method: 'GET',
    pattern: /^\/filesystem\/directories$/,
    handler: async ({ url }) => {
      const requestedPath = url.searchParams.get('path') || '';
      return listLocalDirectories({ config, requestedPath });
    },
  },
  {
    method: 'POST',
    pattern: /^\/workspaces$/,
    handler: async ({ body }) => {
      const ownerUserID = requiredString(body.ownerUserID, 'ownerUserID');
      const targetPath = requiredString(body.targetPath, 'targetPath');
      const workspace = await createWorkspace({
        store,
        config,
        ownerUserID,
        name: typeof body.name === 'string' ? body.name : '',
        targetPath,
      });
      return { workspace };
    },
  },
  {
    method: 'GET',
    pattern: /^\/conversations\/(?<conversationID>[^/]+)\/workspace$/,
    handler: async ({ params, url }) => {
      const ownerUserID = requiredString(url.searchParams.get('ownerUserID'), 'ownerUserID');
      const autoCreate = url.searchParams.get('autoCreate') === '1';
      return getConversationWorkspace({
        store,
        config,
        ownerUserID,
        conversationID: decodeURIComponent(params.conversationID),
        autoCreate,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/conversations\/(?<conversationID>[^/]+)\/workspace$/,
    handler: async ({ params, body }) => {
      const ownerUserID = requiredString(body.ownerUserID, 'ownerUserID');
      const workspaceID = requiredString(body.workspaceID, 'workspaceID');
      return bindConversationWorkspace({
        store,
        config,
        ownerUserID,
        conversationID: decodeURIComponent(params.conversationID),
        workspaceID,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/workspaces\/(?<workspaceID>[^/]+)\/files$/,
    handler: async ({ params, url }) => {
      const ownerUserID = requiredString(url.searchParams.get('ownerUserID'), 'ownerUserID');
      const workspace = await requireWorkspace({ store, config, ownerUserID, workspaceID: params.workspaceID });
      return listWorkspaceFiles({
        workspace,
        source: url.searchParams.get('source') === 'target' ? 'target' : 'sandbox',
        dir: url.searchParams.get('dir') || '',
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/workspaces\/(?<workspaceID>[^/]+)\/file$/,
    handler: async ({ params, url }) => {
      const ownerUserID = requiredString(url.searchParams.get('ownerUserID'), 'ownerUserID');
      const filePath = requiredString(url.searchParams.get('path'), 'path');
      const workspace = await requireWorkspace({ store, config, ownerUserID, workspaceID: params.workspaceID });
      return readWorkspaceFile({
        workspace,
        source: url.searchParams.get('source') === 'target' ? 'target' : 'sandbox',
        filePath,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/workspaces\/(?<workspaceID>[^/]+)\/file$/,
    handler: async ({ params, body }) => {
      const ownerUserID = requiredString(body.ownerUserID, 'ownerUserID');
      const filePath = requiredString(body.path, 'path');
      const workspace = await requireWorkspace({ store, config, ownerUserID, workspaceID: params.workspaceID });
      return writeWorkspaceFile({
        workspace,
        source: 'sandbox',
        filePath,
        content: typeof body.content === 'string' ? body.content : '',
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/my\/agents$/,
    handler: async ({ url }) => {
      const ownerUserID = url.searchParams.get('ownerUserID');
      if (!ownerUserID) throw new HttpError(400, 'ownerUserID is required');

      const userAgents = await store.readCollection('agents');
      const agents = userAgents.filter((agent) => agent.ownerUserID === ownerUserID);
      return { agents, total: agents.length };
    },
  },
  {
    method: 'POST',
    pattern: /^\/my\/agents$/,
    handler: async ({ body }) => {
      const ownerUserID = requiredString(body.ownerUserID, 'ownerUserID');
      const now = Date.now();
      const userAgentID = `ua_${now}_${randomUUID().slice(0, 8)}`;
      const imAgentUserID = `agent_custom_${ownerUserID}`.replace(/[^a-zA-Z0-9_-]/g, '_');

      const agent = {
        userAgentID,
        ownerUserID,
        templateID: 'custom',
        imAgentUserID,
        nickname: typeof body.nickname === 'string' ? body.nickname.trim() : 'Custom Agent',
        avatarURL: typeof body.avatarURL === 'string' ? body.avatarURL.trim() : '',
        credentialID: typeof body.credentialID === 'string' ? body.credentialID.trim() : '',
        systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '',
        enabledToolIDs: Array.isArray(body.enabledToolIDs) ? body.enabledToolIDs : [],
        enabledMcpConnectionIDs: Array.isArray(body.enabledMcpConnectionIDs) ? body.enabledMcpConnectionIDs : [],
        runtime: typeof body.runtime === 'string' ? body.runtime.trim() : 'openai-tools',
        workerTemplateID: typeof body.workerTemplateID === 'string' ? body.workerTemplateID.trim() : '',
        workerAgentUserID: typeof body.workerAgentUserID === 'string' ? body.workerAgentUserID.trim() : '',
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

      const userAgents = await store.readCollection('agents');
      userAgents.push(agent);
      await store.writeCollection('agents', userAgents);

      void connectAgentWs(agent);

      return { agent };
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
    pattern: /^\/runs\/by-message\/(?<serverMsgID>[^/]+)$/,
    handler: async ({ params, url }) => {
      const ownerUserID = requiredString(url.searchParams.get('ownerUserID'), 'ownerUserID');
      const serverMsgID = decodeURIComponent(params.serverMsgID);
      const runs = await store.readCollection('agent-runs');
      const run = runs
        .filter((item) => item.ownerUserID === ownerUserID)
        .find((item) =>
          item.responseServerMsgID === serverMsgID ||
          item.output?.serverMsgID === serverMsgID ||
          (item.graphSteps || []).some((step) => step.serverMsgID === serverMsgID)
        );
      if (!run) throw new HttpError(404, 'Run not found for message');
      return { run };
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
    method: 'POST',
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)\/runs\/(?<runID>[^/]+)\/patch\/preview$/,
    handler: async ({ params, body }) => {
      const { runs, run, index } = await requireAgentRun(params.userAgentID, params.runID);
      const proposal = await createPatchPreview({ config, run, body });
      const updated = {
        ...run,
        patchProposal: proposal,
        approvals: normalizeApprovals([
          ...(run.approvals || []).filter((approval) => approval.type !== 'patch'),
          {
            type: 'patch',
            status: proposal.status,
            requestedByAgentID: run.userAgentID,
            proposalID: proposal.proposalID,
            createTime: proposal.createTime,
            files: proposal.files,
          },
        ]),
        artifacts: normalizeArtifacts([
          ...(run.artifacts || []).filter((artifact) => artifact.type !== 'patch_proposal'),
          {
            type: 'patch_proposal',
            proposalID: proposal.proposalID,
            status: proposal.status,
            files: proposal.files,
            createTime: proposal.createTime,
          },
        ]),
      };
      runs[index] = updated;
      await store.writeCollection('agent-runs', runs);
      return { proposal, run: updated };
    },
  },
  {
    method: 'POST',
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)\/runs\/(?<runID>[^/]+)\/patch\/apply$/,
    handler: async ({ params }) => {
      const { runs, run, index } = await requireAgentRun(params.userAgentID, params.runID);
      const proposal = await applyPatchProposal({ config, run, proposal: run.patchProposal });
      const updated = {
        ...run,
        patchProposal: proposal,
        approvals: normalizeApprovals([
          ...(run.approvals || []).filter((approval) => approval.type !== 'patch'),
          {
            type: 'patch',
            status: proposal.status,
            requestedByAgentID: run.userAgentID,
            approvedByUserID: run.ownerUserID,
            proposalID: proposal.proposalID,
            createTime: proposal.createTime,
            applyTime: proposal.appliedTime,
            files: proposal.files,
          },
        ]),
        artifacts: normalizeArtifacts([
          ...(run.artifacts || []).filter((artifact) => artifact.type !== 'patch_proposal'),
          {
            type: 'patch_proposal',
            proposalID: proposal.proposalID,
            status: proposal.status,
            files: proposal.files,
            appliedFiles: proposal.appliedFiles,
            createTime: proposal.createTime,
            appliedTime: proposal.appliedTime,
          },
        ]),
      };
      runs[index] = updated;
      await store.writeCollection('agent-runs', runs);
      return { proposal, run: updated };
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)$/,
    handler: async ({ params, body }) => {
      const userAgents = await store.readCollection('agents');
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
      await store.writeCollection('agents', userAgents);

      void connectAgentWs(agent);

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

      const userAgents = await store.readCollection('agents');
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
        credentialID: body.credentialID || '',
        systemPrompt: body.systemPrompt || template.defaultSystemPrompt,
        enabledToolIDs: Array.isArray(body.enabledToolIDs) ? body.enabledToolIDs : template.defaultToolIDs,
        enabledMcpConnectionIDs: Array.isArray(body.enabledMcpConnectionIDs) ? body.enabledMcpConnectionIDs : [],
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
      await store.writeCollection('agents', userAgents);

      void connectAgentWs(agent);

      return { agent, created: true };
    },
  },
  {
    method: 'POST',
    pattern: /^\/my\/agents\/(?<userAgentID>[^/]+)\/test$/,
    handler: async ({ params, body }) => {
      const agent = await requireUserAgent(params.userAgentID);
      return testAgentProvider(store, agent, body);
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
      const userAgents = await store.readCollection('agents');
      const agent = userAgents.find((item) => item.imAgentUserID === event.recvID);
      if (!agent) throw new HttpError(404, `Agent binding not found: ${event.recvID}`);

      const runID = `run_${randomUUID()}`;
      void runMockAgentReply(runID, agent, event, {
        handleGroupPlanConfirmation,
        runVisibleGroupCollaboration,
        sendGroupCollaborationError,
      }).catch((err) => {
        log.error(`Agent 回复失败: agent=${agent.nickname || agent.templateID}`, err);
      });

      return { accepted: true, runID };
    },
  },
  {
    method: 'GET',
    pattern: /^\/debug\/tool-catalog$/,
    handler: async () => ({ tools: toolCatalog }),
  },
  {
    method: 'GET',
    pattern: /^\/credentials$/,
    handler: async ({ url }) => {
      const ownerUserID = requiredString(url.searchParams.get('ownerUserID'), 'ownerUserID');
      const credentials = await store.readCollection('credentials');
      const userCredentials = credentials.filter((cred) =>
        cred.ownerUserID === ownerUserID || cred.ownerUserID === 'anonymous'
      );
      return { credentials: userCredentials, total: userCredentials.length };
    },
  },
  {
    method: 'POST',
    pattern: /^\/credentials$/,
    handler: async ({ body }) => {
      const ownerUserID = requiredString(body.ownerUserID, 'ownerUserID');
      const apiKey = requiredString(body.apiKey, 'apiKey');
      const baseUrl = requiredString(body.baseUrl, 'baseUrl');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const modelName = requiredString(body.modelName, 'modelName');
      const provider = typeof body.provider === 'string' ? body.provider.trim() : 'openai';
      if (!provider) throw new HttpError(400, 'provider is required');
      return createCredential({ ownerUserID, apiKey, baseUrl, name, modelName, provider });
    },
  },
  {
    method: 'GET',
    pattern: /^\/credentials\/(?<credentialID>[^/]+)$/,
    handler: async ({ params, url }) => {
      const credential = await requireCredential(params.credentialID, url);
      return { credential };
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/credentials\/(?<credentialID>[^/]+)$/,
    handler: async ({ params, url, body }) => {
      const credentials = await store.readCollection('credentials');
      const index = credentials.findIndex((cred) => cred.credentialID === params.credentialID);
      if (index === -1) throw new HttpError(404, 'Credential not found');
      const ownerUserID = url.searchParams.get('ownerUserID') || '';
      if (credentials[index].ownerUserID !== 'anonymous' && credentials[index].ownerUserID !== ownerUserID) {
        throw new HttpError(403, 'Cannot modify this credential');
      }
      const updates = {};
      for (const key of ['apiKey', 'baseUrl', 'name', 'modelName', 'provider']) {
        if (typeof body[key] === 'string') updates[key] = body[key].trim();
      }
      credentials[index] = { ...credentials[index], ...updates, updateTime: Date.now() };
      await store.writeCollection('credentials', credentials);
      return { credential: credentials[index] };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/credentials\/(?<credentialID>[^/]+)$/,
    handler: async ({ params, url }) => {
      const credentials = await store.readCollection('credentials');
      const index = credentials.findIndex((cred) => cred.credentialID === params.credentialID);
      if (index === -1) throw new HttpError(404, 'Credential not found');
      const ownerUserID = url.searchParams.get('ownerUserID') || '';
      if (credentials[index].ownerUserID === 'anonymous') {
        throw new HttpError(403, 'Cannot delete anonymous credential');
      }
      if (credentials[index].ownerUserID !== ownerUserID) {
        throw new HttpError(403, 'Cannot delete this credential');
      }
      const deleted = credentials.splice(index, 1)[0];
      await store.writeCollection('credentials', credentials);
      return { credential: deleted };
    },
  },
  {
    method: 'GET',
    pattern: /^\/mcp-connections$/,
    handler: async ({ url }) => {
      const ownerUserID = requiredString(url.searchParams.get('ownerUserID'), 'ownerUserID');
      const connections = await store.readCollection('mcp-connections');
      const userConnections = connections.filter((conn) => conn.ownerUserID === ownerUserID);
      return { connections: userConnections, total: userConnections.length };
    },
  },
  {
    method: 'POST',
    pattern: /^\/mcp-connections$/,
    handler: async ({ body }) => {
      const ownerUserID = requiredString(body.ownerUserID, 'ownerUserID');
      const name = requiredString(body.name, 'name');
      const url = requiredString(body.url, 'url');
      return createMcpConnection({ ownerUserID, name, url });
    },
  },
  {
    method: 'GET',
    pattern: /^\/mcp-connections\/(?<mcpConnectionID>[^/]+)$/,
    handler: async ({ params }) => {
      const connection = await requireMcpConnection(params.mcpConnectionID);
      return { connection };
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/mcp-connections\/(?<mcpConnectionID>[^/]+)$/,
    handler: async ({ params, body }) => {
      const connections = await store.readCollection('mcp-connections');
      const index = connections.findIndex((conn) => conn.mcpConnectionID === params.mcpConnectionID);
      if (index === -1) throw new HttpError(404, 'MCP connection not found');

      if (typeof body.name === 'string') connections[index].name = body.name.trim();
      if (typeof body.url === 'string') {
        connections[index].url = body.url.trim();
      }

      try {
        connections[index].tools = await discoverMcpTools(connections[index].url);
        connections[index].status = 'active';
      } catch (err) {
        connections[index].status = 'error';
        log.warn(`MCP 工具重新发现失败: ${connections[index].url}, ${err.message}`);
      }
      connections[index].updateTime = Date.now();
      await store.writeCollection('mcp-connections', connections);
      return { connection: connections[index] };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/mcp-connections\/(?<mcpConnectionID>[^/]+)$/,
    handler: async ({ params }) => {
      const connections = await store.readCollection('mcp-connections');
      const index = connections.findIndex((conn) => conn.mcpConnectionID === params.mcpConnectionID);
      if (index === -1) throw new HttpError(404, 'MCP connection not found');
      const deleted = connections.splice(index, 1)[0];
      await store.writeCollection('mcp-connections', connections);
      return { connection: deleted };
    },
  },
];

const createdAgents = await seedData(store, imClient, log, createCredential);

const server = createJsonServer(routes);
server.listen(config.port, () => {
  log.info(`ChatBotHost 启动成功, 端口: ${config.port}`);
  log.info(`IM 服务器: ${config.imServerBaseURL}`);
  log.info(`存储目录: ${config.storageDir}`);
  log.info(`工作区根目录: ${config.workspaceRoot}`);
  log.info(`agent/runs 等数据保存在: ${store.storageDir}`);
  log.info(`LangGraph: ${langGraphRuntime.available ? '可用' : '不可用'} (${langGraphRuntime.source})`);
  log.info(`LangGraph Supervisor: ${langGraphSupervisorRuntime.available ? '可用' : '不可用'} (${langGraphSupervisorRuntime.source})`);
});

if (createdAgents) {
  void startAgentWsConnections();
}

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

async function createCredential({ ownerUserID, apiKey, baseUrl, name, modelName, provider }) {
  const credentials = await store.readCollection('credentials');
  const credentialID = `cred_${randomUUID()}`;
  const now = Date.now();
  const credential = {
    credentialID,
    ownerUserID,
    apiKey,
    baseUrl,
    name: name || '',
    modelName: modelName || '',
    provider,
    createTime: now,
    updateTime: now,
  };
  credentials.push(credential);
  await store.writeCollection('credentials', credentials);
  return { credential };
}

async function requireCredential(credentialID, url) {
  const credentials = await store.readCollection('credentials');
  const credential = credentials.find((cred) => cred.credentialID === credentialID);
  if (!credential) throw new HttpError(404, 'Credential not found');
  const ownerUserID = url.searchParams.get('ownerUserID') || '';
  if (credential.ownerUserID !== 'anonymous' && credential.ownerUserID !== ownerUserID && ownerUserID) {
    throw new HttpError(403, 'Cannot access this credential');
  }
  return credential;
}

async function createMcpConnection({ ownerUserID, name, url }) {
  const connections = await store.readCollection('mcp-connections');
  const mcpConnectionID = `mcp_${randomUUID()}`;
  const now = Date.now();
  const connection = {
    mcpConnectionID,
    ownerUserID,
    name,
    url,
    transport: 'http',
    tools: [],
    status: 'active',
    createTime: now,
    updateTime: now,
  };

  try {
    connection.tools = await discoverMcpTools(url);
    log.info(`MCP 连接创建并发现工具: ${mcpConnectionID}, ${connection.tools.length} 个工具`);
  } catch (err) {
    connection.status = 'error';
    log.warn(`MCP 工具发现失败: ${url}, ${err.message}`);
  }

  connections.push(connection);
  await store.writeCollection('mcp-connections', connections);
  return { connection };
}

async function requireMcpConnection(mcpConnectionID) {
  const connections = await store.readCollection('mcp-connections');
  const connection = connections.find((conn) => conn.mcpConnectionID === mcpConnectionID);
  if (!connection) throw new HttpError(404, 'MCP connection not found');
  return connection;
}

function clampInteger(value, defaultValue, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

async function requireUserAgent(userAgentID) {
  const userAgents = await store.readCollection('agents');
  const agent = userAgents.find((item) => item.userAgentID === userAgentID);
  if (!agent) throw new HttpError(404, 'Agent not found');
  return agent;
}

async function requireAgentRun(userAgentID, runID) {
  await requireUserAgent(userAgentID);
  const runs = await store.readCollection('agent-runs');
  const index = runs.findIndex((item) => item.userAgentID === userAgentID && item.runID === runID);
  if (index === -1) throw new HttpError(404, 'Run not found');
  return { runs, run: runs[index], index };
}

function parseMessageEvent(body) {
  return {
    conversationID: requiredString(body.conversationID, 'conversationID'),
    sendID: requiredString(body.sendID, 'sendID'),
    recvID: requiredString(body.recvID, 'recvID'),
    groupID: typeof body.groupID === 'string' ? body.groupID : '',
    content: typeof body.content === 'string' ? body.content : '',
    serverMsgID: typeof body.serverMsgID === 'string' ? body.serverMsgID : '',
    contentType: typeof body.contentType === 'number' ? body.contentType : 101,
    sessionType: typeof body.sessionType === 'number' ? body.sessionType : 1,
    atUserIDList: Array.isArray(body.atUserIDList) ? body.atUserIDList.filter((id) => typeof id === 'string') : [],
    mentionedAgentIDs: Array.isArray(body.mentionedAgentIDs) ? body.mentionedAgentIDs.filter((id) => typeof id === 'string') : [],
  };
}

function sanitizeAgentUpdates(body) {
  const updates = {};
  for (const key of [
    'nickname',
    'avatarURL',
    'credentialID',
    'systemPrompt',
    'runtime',
    'workerTemplateID',
    'workerAgentUserID',
  ]) {
    if (typeof body[key] === 'string') updates[key] = body[key].trim();
  }
  if (updates.runtime && !['openai-tools', 'langgraph-planner-worker', 'langchain-agent', 'langgraph-supervisor'].includes(updates.runtime)) {
    delete updates.runtime;
  }
  if (Array.isArray(body.enabledToolIDs)) {
    const validIDs = new Set(listTools().map((tool) => tool.toolID));
    updates.enabledToolIDs = body.enabledToolIDs.filter((id) => typeof id === 'string' && validIDs.has(id));
  }
  if (Array.isArray(body.enabledMcpConnectionIDs)) {
    updates.enabledMcpConnectionIDs = body.enabledMcpConnectionIDs.filter((id) => typeof id === 'string');
  }
  return updates;
}
