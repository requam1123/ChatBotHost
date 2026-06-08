import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createJsonServer, HttpError } from './http.js';
import { JsonStore } from './storage.js';
import { ImClient } from './im-client.js';
import { getTemplate, listActiveTemplates } from './market.js';
import { executeToolCall, findTools, listTools, toolCatalog } from './tools.js';
import { generateAgentReply, testAgentProvider } from './providers.js';
import { createLangGraphRuntime } from './langgraph-runtime.js';
import { generateLangChainAgentReply } from './langchain-agent-runtime.js';
import { applyPatchProposal, createPatchPreview } from './patch-manager.js';
import { createLangGraphSupervisorRuntime } from './langgraph-supervisor-runtime.js';
import {
  buildArtifactsFromToolCalls,
  normalizeArtifacts,
  normalizeApprovals,
  normalizeGraphSteps,
  normalizeToolCalls,
} from './run-records.js';

const config = loadConfig();
const store = new JsonStore(config.storageDir);
const imClient = new ImClient(config.imServerBaseURL);
const langGraphRuntime = await createLangGraphRuntime();
const langGraphSupervisorRuntime = await createLangGraphSupervisorRuntime();

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
        localAgentProvider: body.localAgentProvider || template.defaultLocalAgentProvider || '',
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
      const runtime = body.runtime || agent.runtime;
      if (runtime === 'local-cli-agent') {
        const provider = body.localAgentProvider || agent.localAgentProvider || inferLocalAgentProvider(agent);
        return {
          ok: ['codex', 'claude', 'opencode'].includes(provider),
          provider: 'local-cli',
          endpoint: '',
          model: provider,
          message: `Local CLI provider configured: ${provider}`,
        };
      }
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
    groupID: typeof body.groupID === 'string' ? body.groupID : '',
    content: typeof body.content === 'string' ? body.content : '',
    serverMsgID: typeof body.serverMsgID === 'string' ? body.serverMsgID : '',
    contentType: typeof body.contentType === 'number' ? body.contentType : 101,
    sessionType: typeof body.sessionType === 'number' ? body.sessionType : 1,
    atUserIDList: Array.isArray(body.atUserIDList) ? body.atUserIDList.filter((id) => typeof id === 'string') : [],
    mentionedAgentIDs: Array.isArray(body.mentionedAgentIDs) ? body.mentionedAgentIDs.filter((id) => typeof id === 'string') : [],
  };
}

async function runMockAgentReply(runID, agent, event) {
  if (event.groupID && agent.runtime === 'langgraph-planner-worker') {
    await runVisibleGroupCollaboration(runID, agent, event);
    return;
  }

  const startTime = Date.now();
  const result = await buildAgentReplyForRuntime(agent, event, {
    runID,
    rootRunID: runID,
    parentRunID: '',
    depth: 0,
    allowDelegate: true,
  });
  const replyText = result.content;
  if (result.runtime === 'local-cli-agent') {
    const sent = await imClient.sendMessage({
      sendID: agent.imAgentUserID,
      recvID: event.groupID ? undefined : event.sendID,
      groupID: event.groupID || undefined,
      content: replyText,
      senderNickname: agent.nickname,
      senderFaceURL: agent.avatarURL,
    });
    const serverMsgID = sent.serverMsgID;
    if (!serverMsgID) throw new Error('IM send_msg did not return serverMsgID');
    const runs = await store.readCollection('agent-runs');
    const endTime = Date.now();
    runs.push(buildRunRecord({
      runID,
      responseServerMsgID: serverMsgID,
      output: {
        sendID: agent.imAgentUserID,
        recvID: event.sendID,
        groupID: event.groupID,
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
    return;
  }
  const initial = '正在思考...';
  const sent = await imClient.sendMessage({
    sendID: agent.imAgentUserID,
    recvID: event.groupID ? undefined : event.sendID,
    groupID: event.groupID || undefined,
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
      groupID: event.groupID,
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

async function runVisibleGroupCollaboration(runID, plannerAgent, event) {
  if (langGraphSupervisorRuntime.available && langGraphSupervisorRuntime.runVisibleSupervisorGraph) {
    try {
      await runVisibleGroupCollaborationWithSupervisor(runID, plannerAgent, event);
      return;
    } catch (err) {
      console.error('LangGraph supervisor visible collaboration failed, falling back to legacy flow', err);
    }
  }
  await runVisibleGroupCollaborationLegacy(runID, plannerAgent, event);
}

async function runVisibleGroupCollaborationLegacy(runID, plannerAgent, event) {
  const startTime = Date.now();
  const workerAgent = await requireWorkerAgent(plannerAgent, {
    agentUserID: plannerAgent.workerAgentUserID || '',
    templateID: plannerAgent.workerTemplateID || 'coder',
  });
  const reviewerAgent = await findOptionalAgent(plannerAgent, 'reviewer');

  const mentionNames = [plannerAgent.nickname, workerAgent.nickname, reviewerAgent?.nickname].filter(Boolean);
  const cleanTask = stripMentionText(event.content, mentionNames);
  const plannerAck = reviewerAgent
    ? `@${event.sendID} 收到，我先规划一下：\n1. 代码实现交给 Coder\n2. Coder 完成后 @我 回传代码\n3. 我再 @Reviewer 做代码审查\n4. 我最后 @${event.sendID} 汇总最终结果`
    : `@${event.sendID} 收到，我先规划一下：\n1. 代码实现交给 Coder\n2. Coder 完成后 @我 回传代码\n3. 我最后 @${event.sendID} 汇总最终结果`;
  const plannerAckMsg = await sendGroupText(plannerAgent, event.groupID, plannerAck, [event.sendID]);

  const plannerDelegate = `@${workerAgent.nickname} 请完成这个代码任务：${cleanTask}`;
  const plannerDelegateMsg = await sendGroupText(plannerAgent, event.groupID, plannerDelegate, [workerAgent.imAgentUserID]);

  const coderAck = `@${plannerAgent.nickname} 收到，我开始实现这个函数，并会把代码结果回传给你。`;
  const coderAckMsg = await sendGroupText(workerAgent, event.groupID, coderAck, [plannerAgent.imAgentUserID]);

  const workerTask = `请完成用户交给 Planner 的代码任务，并只输出可用代码和必要说明。\n\n用户任务：\n${cleanTask}`;
  const workerStartTime = Date.now();
  const workerRunID = `${runID}_worker`;
  const workerResult = await buildGraphNodeReply(workerAgent, {
    ...event,
    sendID: plannerAgent.imAgentUserID,
    recvID: workerAgent.imAgentUserID,
    content: workerTask,
    serverMsgID: '',
  }, { runID: workerRunID, workspaceID: runID, allowTools: true });
  const workerEndTime = Date.now();

  const coderResultText = `@${plannerAgent.nickname} 我完成了代码实现：\n\n${workerResult.content}`;
  const coderResultMsg = await sendGroupText(workerAgent, event.groupID, coderResultText, [plannerAgent.imAgentUserID]);

  let reviewerAckMsg = null;
  let reviewerResultMsg = null;
  let reviewerResult = null;
  const allToolCalls = tagToolCalls(workerResult.toolCalls || [], 'worker', workerAgent);
  const resultGraphExtraSteps = [];
  if (reviewerAgent) {
    const plannerReviewRequest = `@${reviewerAgent.nickname} 请审查 Coder 的实现，重点看正确性、边界情况和可维护性。`;
    const plannerReviewMsg = await sendGroupText(plannerAgent, event.groupID, plannerReviewRequest, [reviewerAgent.imAgentUserID]);
    reviewerAckMsg = await sendGroupText(reviewerAgent, event.groupID, `@${plannerAgent.nickname} 收到，我开始审查 Coder 的代码。`, [plannerAgent.imAgentUserID]);
    const reviewTask = `请审查下面的 TypeScript 实现，重点关注正确性、边界条件、类型设计、可维护性，并给出是否可交付的结论。\n\n用户任务：\n${cleanTask}\n\nCoder 输出：\n${workerResult.content}`;
    const reviewerRunID = `${runID}_reviewer`;
    reviewerResult = await buildGraphNodeReply(reviewerAgent, {
      ...event,
      sendID: plannerAgent.imAgentUserID,
      recvID: reviewerAgent.imAgentUserID,
      content: reviewTask,
      serverMsgID: '',
    }, { runID: reviewerRunID, workspaceID: runID, allowTools: true });
    allToolCalls.push(...tagToolCalls(reviewerResult.toolCalls || [], 'reviewer', reviewerAgent));
    reviewerResultMsg = await sendGroupText(
      reviewerAgent,
      event.groupID,
      `@${plannerAgent.nickname} 我完成审查：\n\n${reviewerResult.content}`,
      [plannerAgent.imAgentUserID],
    );
    resultGraphExtraSteps.push(
      { node: 'planner_review_request', agentID: plannerAgent.userAgentID, output: plannerReviewRequest, serverMsgID: plannerReviewMsg.serverMsgID, time: Date.now() },
      { node: 'reviewer_ack', agentID: reviewerAgent.userAgentID, output: `@${plannerAgent.nickname} 收到，我开始审查 Coder 的代码。`, serverMsgID: reviewerAckMsg.serverMsgID, time: Date.now() },
      {
        node: 'reviewer',
        agentID: reviewerAgent.userAgentID,
        output: reviewerResult.content,
        serverMsgID: reviewerResultMsg.serverMsgID,
        provider: reviewerResult.provider,
        endpoint: reviewerResult.endpoint,
        model: reviewerResult.model,
        time: Date.now(),
      },
    );
  }

  const summaryTask = `Coder 已完成代码实现${reviewerResult ? '，Reviewer 已完成审查' : ''}，请你面向用户总结最终结果，并保留核心代码。\n\n用户原始任务：\n${cleanTask}\n\nCoder 输出：\n${workerResult.content}${reviewerResult ? `\n\nReviewer 输出：\n${reviewerResult.content}` : ''}`;
  const summaryResult = await buildGraphNodeReply(plannerAgent, {
    ...event,
    content: summaryTask,
  });
  const finalText = `@${event.sendID} ${summaryResult.content}`;
  const finalMsg = await sendGroupText(plannerAgent, event.groupID, finalText, [event.sendID]);

  const endTime = Date.now();
  const result = {
    content: finalText,
    mode: 'langgraph-visible',
    runtime: 'langgraph-planner-worker',
    status: 'success',
    provider: summaryResult.provider || workerResult.provider || plannerAgent.provider || '',
    endpoint: summaryResult.endpoint || workerResult.endpoint || plannerAgent.endpoint || '',
    model: summaryResult.model || workerResult.model || plannerAgent.model || '',
    toolCalls: [],
    error: '',
    graphSteps: [
      { node: 'planner_ack', output: plannerAck, serverMsgID: plannerAckMsg.serverMsgID, time: startTime },
      { node: 'planner_delegate', output: plannerDelegate, serverMsgID: plannerDelegateMsg.serverMsgID, time: startTime },
      { node: 'worker_ack', agentID: workerAgent.userAgentID, output: coderAck, serverMsgID: coderAckMsg.serverMsgID, time: workerStartTime },
      {
        node: 'worker',
        agentID: workerAgent.userAgentID,
        output: workerResult.content,
        serverMsgID: coderResultMsg.serverMsgID,
        provider: workerResult.provider,
        endpoint: workerResult.endpoint,
        model: workerResult.model,
        toolCalls: tagToolCalls(workerResult.toolCalls || [], 'worker', workerAgent),
        time: workerEndTime,
      },
      ...resultGraphExtraSteps,
      {
        node: 'summary',
        agentID: plannerAgent.userAgentID,
        output: summaryResult.content,
        serverMsgID: finalMsg.serverMsgID,
        provider: summaryResult.provider,
        endpoint: summaryResult.endpoint,
        model: summaryResult.model,
        time: endTime,
      },
    ],
    workerAgentID: workerAgent.userAgentID,
    workerAgentUserID: workerAgent.imAgentUserID,
    workerTemplateID: workerAgent.templateID,
    workerOutput: workerResult.content,
    toolCalls: allToolCalls,
    finalOutput: finalText,
  };

  const runs = await store.readCollection('agent-runs');
  runs.push(buildRunRecord({
    runID,
    responseServerMsgID: finalMsg.serverMsgID,
    output: {
      sendID: plannerAgent.imAgentUserID,
      recvID: event.sendID,
      groupID: event.groupID,
      content: finalText,
      serverMsgID: finalMsg.serverMsgID,
    },
    agent: plannerAgent,
    event,
    result,
    startTime,
    endTime,
  }));
  await store.writeCollection('agent-runs', runs);
}

async function runVisibleGroupCollaborationWithSupervisor(runID, plannerAgent, event) {
  const startTime = Date.now();
  const workerAgent = await requireWorkerAgent(plannerAgent, {
    agentUserID: plannerAgent.workerAgentUserID || '',
    templateID: plannerAgent.workerTemplateID || 'coder',
  });
  const reviewerAgent = await findOptionalAgent(plannerAgent, 'reviewer');
  const mentionNames = [plannerAgent.nickname, workerAgent.nickname, reviewerAgent?.nickname].filter(Boolean);
  const cleanTask = stripMentionText(event.content, mentionNames);

  const graphResult = await langGraphSupervisorRuntime.runVisibleSupervisorGraph({
    runID,
    task: event.content,
    cleanTask,
    plannerAgent,
    workerAgent,
    reviewerAgent,
    event,
    nodes: {
      plannerAck: async (state) => {
        const plannerAck = state.reviewerAgent
          ? `@${state.event.sendID} 收到，我先规划一下：\n1. 代码实现交给 Coder\n2. Coder 完成后 @我 回传代码\n3. 我再 @Reviewer 做代码审查\n4. 我最后 @${state.event.sendID} 汇总最终结果`
          : `@${state.event.sendID} 收到，我先规划一下：\n1. 代码实现交给 Coder\n2. Coder 完成后 @我 回传代码\n3. 我最后 @${state.event.sendID} 汇总最终结果`;
        const sent = await sendGroupText(state.plannerAgent, state.event.groupID, plannerAck, [state.event.sendID]);
        const time = Date.now();
        return {
          plannerAck,
          graphSteps: [{
            node: 'planner_ack',
            agentID: state.plannerAgent.userAgentID,
            agentUserID: state.plannerAgent.imAgentUserID,
            agentNickname: state.plannerAgent.nickname,
            output: plannerAck,
            serverMsgID: sent.serverMsgID,
            startTime: time,
            endTime: time,
            time,
          }],
        };
      },
      plannerDelegate: async (state) => {
        const plannerDelegate = `@${state.workerAgent.nickname} 请完成这个代码任务：${state.cleanTask}`;
        const delegateMsg = await sendGroupText(state.plannerAgent, state.event.groupID, plannerDelegate, [state.workerAgent.imAgentUserID]);
        const coderAck = `@${state.plannerAgent.nickname} 收到，我开始实现这个函数，并会把代码结果回传给你。`;
        const ackMsg = await sendGroupText(state.workerAgent, state.event.groupID, coderAck, [state.plannerAgent.imAgentUserID]);
        const time = Date.now();
        return {
          plannerDelegate,
          coderAck,
          workerTask: `请完成用户交给 Planner 的代码任务，并只输出可用代码和必要说明。\n\n用户任务：\n${state.cleanTask}`,
          graphSteps: [
            {
              node: 'planner_delegate',
              agentID: state.plannerAgent.userAgentID,
              agentUserID: state.plannerAgent.imAgentUserID,
              agentNickname: state.plannerAgent.nickname,
              output: plannerDelegate,
              serverMsgID: delegateMsg.serverMsgID,
              startTime: time,
              endTime: time,
              time,
            },
            {
              node: 'worker_ack',
              agentID: state.workerAgent.userAgentID,
              agentUserID: state.workerAgent.imAgentUserID,
              agentNickname: state.workerAgent.nickname,
              output: coderAck,
              serverMsgID: ackMsg.serverMsgID,
              startTime: time,
              endTime: time,
              time,
            },
          ],
        };
      },
      worker: async (state) => {
        const nodeStartTime = Date.now();
        const workerResult = await buildGraphNodeReply(state.workerAgent, {
          ...state.event,
          sendID: state.plannerAgent.imAgentUserID,
          recvID: state.workerAgent.imAgentUserID,
          content: state.workerTask,
          serverMsgID: '',
        }, { runID: `${state.runID}_worker`, workspaceID: state.runID, allowTools: true });
        const taggedToolCalls = tagToolCalls(workerResult.toolCalls || [], 'worker', state.workerAgent);
        const coderResultText = `@${state.plannerAgent.nickname} 我完成了代码实现：\n\n${workerResult.content}`;
        const resultMsg = await sendGroupText(state.workerAgent, state.event.groupID, coderResultText, [state.plannerAgent.imAgentUserID]);
        const nodeEndTime = Date.now();
        return {
          workerOutput: workerResult.content,
          toolCalls: taggedToolCalls,
          graphSteps: [{
            node: 'worker',
            agentID: state.workerAgent.userAgentID,
            agentUserID: state.workerAgent.imAgentUserID,
            agentNickname: state.workerAgent.nickname,
            output: workerResult.content,
            serverMsgID: resultMsg.serverMsgID,
            provider: workerResult.provider,
            endpoint: workerResult.endpoint,
            model: workerResult.model,
            toolCalls: taggedToolCalls,
            toolCallIDs: taggedToolCalls.map((call) => call.toolCallID).filter(Boolean),
            startTime: nodeStartTime,
            endTime: nodeEndTime,
            time: nodeEndTime,
          }],
        };
      },
      reviewer: async (state) => {
        const nodeStartTime = Date.now();
        const plannerReviewRequest = `@${state.reviewerAgent.nickname} 请审查 Coder 的实现，重点看正确性、边界情况和可维护性。`;
        const reviewRequestMsg = await sendGroupText(state.plannerAgent, state.event.groupID, plannerReviewRequest, [state.reviewerAgent.imAgentUserID]);
        const reviewerAck = `@${state.plannerAgent.nickname} 收到，我开始审查 Coder 的代码。`;
        const reviewerAckMsg = await sendGroupText(state.reviewerAgent, state.event.groupID, reviewerAck, [state.plannerAgent.imAgentUserID]);
        const reviewTask = `请审查下面的实现，重点关注正确性、边界条件、类型设计、可维护性，并给出是否可交付的结论。\n\n用户任务：\n${state.cleanTask}\n\nCoder 输出：\n${state.workerOutput}`;
        const reviewerResult = await buildGraphNodeReply(state.reviewerAgent, {
          ...state.event,
          sendID: state.plannerAgent.imAgentUserID,
          recvID: state.reviewerAgent.imAgentUserID,
          content: reviewTask,
          serverMsgID: '',
        }, { runID: `${state.runID}_reviewer`, workspaceID: state.runID, allowTools: true });
        const taggedToolCalls = tagToolCalls(reviewerResult.toolCalls || [], 'reviewer', state.reviewerAgent);
        const reviewerResultMsg = await sendGroupText(
          state.reviewerAgent,
          state.event.groupID,
          `@${state.plannerAgent.nickname} 我完成审查：\n\n${reviewerResult.content}`,
          [state.plannerAgent.imAgentUserID],
        );
        const nodeEndTime = Date.now();
        return {
          reviewTask,
          reviewerOutput: reviewerResult.content,
          toolCalls: taggedToolCalls,
          graphSteps: [
            {
              node: 'planner_review_request',
              agentID: state.plannerAgent.userAgentID,
              agentUserID: state.plannerAgent.imAgentUserID,
              agentNickname: state.plannerAgent.nickname,
              output: plannerReviewRequest,
              serverMsgID: reviewRequestMsg.serverMsgID,
              startTime: nodeStartTime,
              endTime: nodeStartTime,
              time: nodeStartTime,
            },
            {
              node: 'reviewer_ack',
              agentID: state.reviewerAgent.userAgentID,
              agentUserID: state.reviewerAgent.imAgentUserID,
              agentNickname: state.reviewerAgent.nickname,
              output: reviewerAck,
              serverMsgID: reviewerAckMsg.serverMsgID,
              startTime: nodeStartTime,
              endTime: nodeStartTime,
              time: nodeStartTime,
            },
            {
              node: 'reviewer',
              agentID: state.reviewerAgent.userAgentID,
              agentUserID: state.reviewerAgent.imAgentUserID,
              agentNickname: state.reviewerAgent.nickname,
              output: reviewerResult.content,
              serverMsgID: reviewerResultMsg.serverMsgID,
              provider: reviewerResult.provider,
              endpoint: reviewerResult.endpoint,
              model: reviewerResult.model,
              toolCalls: taggedToolCalls,
              toolCallIDs: taggedToolCalls.map((call) => call.toolCallID).filter(Boolean),
              startTime: nodeStartTime,
              endTime: nodeEndTime,
              time: nodeEndTime,
            },
          ],
        };
      },
      summary: async (state) => {
        const nodeStartTime = Date.now();
        const summaryTask = `Coder 已完成代码实现${state.reviewerOutput ? '，Reviewer 已完成审查' : ''}，请你面向用户总结最终结果，并保留核心代码。\n\n用户原始任务：\n${state.cleanTask}\n\nCoder 输出：\n${state.workerOutput}${state.reviewerOutput ? `\n\nReviewer 输出：\n${state.reviewerOutput}` : ''}`;
        const summaryResult = await buildGraphNodeReply(state.plannerAgent, {
          ...state.event,
          content: summaryTask,
        });
        const finalText = `@${state.event.sendID} ${summaryResult.content}`;
        const finalMsg = await sendGroupText(state.plannerAgent, state.event.groupID, finalText, [state.event.sendID]);
        const nodeEndTime = Date.now();
        return {
          finalOutput: finalText,
          responseServerMsgID: finalMsg.serverMsgID,
          graphSteps: [{
            node: 'summary',
            agentID: state.plannerAgent.userAgentID,
            agentUserID: state.plannerAgent.imAgentUserID,
            agentNickname: state.plannerAgent.nickname,
            output: summaryResult.content,
            serverMsgID: finalMsg.serverMsgID,
            provider: summaryResult.provider,
            endpoint: summaryResult.endpoint,
            model: summaryResult.model,
            startTime: nodeStartTime,
            endTime: nodeEndTime,
            time: nodeEndTime,
          }],
        };
      },
    },
  });

  const endTime = Date.now();
  const toolCalls = normalizeToolCalls(graphResult.toolCalls || []);
  const result = {
    content: graphResult.finalOutput,
    mode: 'langgraph-supervisor',
    runtime: 'langgraph-supervisor',
    status: 'success',
    provider: plannerAgent.provider || '',
    endpoint: plannerAgent.endpoint || '',
    model: plannerAgent.model || '',
    toolCalls,
    graphSteps: normalizeGraphSteps(graphResult.graphSteps || []),
    artifacts: buildArtifactsFromToolCalls(toolCalls),
    approvals: [],
    error: '',
    workerAgentID: workerAgent.userAgentID,
    workerAgentUserID: workerAgent.imAgentUserID,
    workerTemplateID: workerAgent.templateID,
    workerOutput: graphResult.workerOutput,
    finalOutput: graphResult.finalOutput,
  };

  const runs = await store.readCollection('agent-runs');
  runs.push(buildRunRecord({
    runID,
    responseServerMsgID: graphResult.responseServerMsgID,
    output: {
      sendID: plannerAgent.imAgentUserID,
      recvID: event.sendID,
      groupID: event.groupID,
      content: graphResult.finalOutput,
      serverMsgID: graphResult.responseServerMsgID,
    },
    agent: plannerAgent,
    event,
    result,
    startTime,
    endTime,
  }));
  await store.writeCollection('agent-runs', runs);
}

function tagToolCalls(toolCalls, graphNode, agent) {
  return toolCalls.map((call) => ({
    ...call,
    graphNode,
    agentID: agent.userAgentID,
    agentUserID: agent.imAgentUserID,
    agentNickname: agent.nickname,
  }));
}

async function sendGroupText(agent, groupID, content, atUserIDList = []) {
  return imClient.sendMessage({
    sendID: agent.imAgentUserID,
    groupID,
    content,
    atUserIDList,
    senderNickname: agent.nickname,
    senderFaceURL: agent.avatarURL,
  });
}

function stripMentionText(content, names) {
  let text = content;
  for (const name of names) {
    text = text.replaceAll(`@${name}`, '');
  }
  return text
    .replace(/\s+/g, ' ')
    .replace(/请组织\s*和\s*做/g, '请做')
    .replace(/请组织\s*和\s*完成/g, '请完成')
    .replace(/请让\s*写/g, '请写')
    .replace(/让\s*写/g, '写')
    .trim();
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
  if (agent.runtime === 'local-cli-agent') {
    return buildLocalCliAgentReply(agent, event, runContext);
  }
  return buildAgentReply(agent, event, runContext);
}

async function buildLocalCliAgentReply(agent, event, runContext = {}) {
  const provider = agent.localAgentProvider || inferLocalAgentProvider(agent);
  const startTime = Date.now();
  const result = await executeToolCall('local_agent_run', {
    provider,
    task: event.content || '',
    cwd: '.',
    timeoutMs: 120000,
  }, {
    agent,
    event,
    imClient,
    enabledToolIDs: agent.enabledToolIDs || [],
    workspaceRoot: config.workspaceRoot,
    runID: runContext.runID,
    workspaceID: runContext.workspaceID,
  });
  const toolCall = {
    toolCallID: `tool_${randomUUID()}`,
    toolID: 'local_agent_run',
    args: {
      provider,
      task: event.content || '',
      cwd: '.',
      timeoutMs: 120000,
    },
    result,
    startTime,
    createTime: Date.now(),
    durationMs: Date.now() - startTime,
  };

  return {
    content: summarizeLocalCliResult(provider, result),
    mode: 'local-cli-agent',
    runtime: 'local-cli-agent',
    status: result.ok ? 'success' : 'failed',
    provider: 'local-cli',
    endpoint: '',
    model: provider,
    toolCalls: [toolCall],
    error: result.ok ? '' : result.error || result.stderr || 'Local CLI agent failed',
  };
}

function inferLocalAgentProvider(agent) {
  if (agent.templateID === 'claude-code') return 'claude';
  if (agent.templateID === 'opencode-cli') return 'opencode';
  return 'codex';
}

function summarizeLocalCliResult(provider, result) {
  const files = Array.isArray(result.files) ? result.files : [];
  const fileLines = files.length
    ? files.map((file) => `- ${file.status || 'file'} ${file.path || file.targetPath || file.sandboxPath || ''} (${file.bytes ?? '-'} bytes)`).join('\n')
    : '- no files changed';
  return [
    `本地 ${provider} 执行完成。`,
    '',
    `exitCode: ${result.exitCode ?? '-'}`,
    `timedOut: ${Boolean(result.timedOut)}`,
    '',
    'files:',
    fileLines,
    '',
    'stdout:',
    truncateText(result.stdout || '', 1200),
    '',
    'stderr:',
    truncateText(result.stderr || result.error || '', 1200),
  ].join('\n');
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

async function buildAgentReply(agent, event, runContext = {}) {
  try {
    return await generateLangChainAgentReply(config, agent, event, {
      runID: runContext.runID,
      workspaceID: runContext.workspaceID,
      imClient,
      delegateToAgent: (delegation) => delegateToAgent(agent, event, runContext, delegation),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LangChain agent failed';
    console.error('LangChain agent failed, falling back to provider loop', message);
    try {
      const result = await generateAgentReply(config, agent, event, {
        toolExecutor: (toolID, args, context) => executeToolCall(toolID, args, {
          ...context,
          imClient,
          runContext,
          workspaceRoot: config.workspaceRoot,
          runID: runContext.runID,
          workspaceID: runContext.workspaceID,
          enabledToolIDs: agent.enabledToolIDs || [],
          delegateToAgent: (delegation) => delegateToAgent(agent, event, runContext, delegation),
        }),
      });
      return { ...result, mode: 'provider', status: 'success', error: '' };
    } catch (fallbackErr) {
      const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : message;
      console.error('Provider completion failed, falling back to mock reply', fallbackMessage);
      return {
        content: `${agent.nickname} 暂时无法连接模型，已收到你的消息：${event.content}`,
        mode: 'fallback',
        status: 'failed',
        provider: agent.provider || '',
        endpoint: agent.endpoint || '',
        model: agent.model || '',
        toolCalls: [],
        error: fallbackMessage,
      };
    }
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
  const normalizedToolCalls = normalizeToolCalls(result.toolCalls || []);
  const normalizedGraphSteps = normalizeGraphSteps(result.graphSteps || []);
  const artifacts = normalizeArtifacts([
    ...buildArtifactsFromToolCalls(normalizedToolCalls),
    ...(result.artifacts || []),
  ]);
  const approvals = normalizeApprovals(result.approvals || []);
  const childrenRunIDs = normalizedToolCalls
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
    groupID: event.groupID,
    triggeredByMention: event.groupID ? event.atUserIDList?.includes(agent.imAgentUserID) : false,
    mentionedAgentIDs: event.mentionedAgentIDs || [],
    requestServerMsgID: event.serverMsgID,
    responseServerMsgID,
    status: result.status,
    mode: result.mode,
    runtime: result.runtime || agent.runtime || 'openai-tools',
    provider: result.provider,
    endpoint: result.endpoint,
    model: result.model,
    graphSteps: normalizedGraphSteps,
    workerAgentID: result.workerAgentID || '',
    workerAgentUserID: result.workerAgentUserID || '',
    workerTemplateID: result.workerTemplateID || '',
    workerOutput: result.workerOutput || '',
    finalOutput: result.finalOutput || output.content,
    input: {
      sendID: event.sendID,
      recvID: event.recvID,
      groupID: event.groupID,
      content: event.content,
      contentType: event.contentType,
      serverMsgID: event.serverMsgID,
    },
    output,
    toolCalls: normalizedToolCalls,
    artifacts,
    approvals,
    patchProposal: result.patchProposal || null,
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

async function requireAgentRun(userAgentID, runID) {
  await requireUserAgent(userAgentID);
  const runs = await store.readCollection('agent-runs');
  const index = runs.findIndex((item) => item.userAgentID === userAgentID && item.runID === runID);
  if (index === -1) throw new HttpError(404, 'Run not found');
  return { runs, run: runs[index], index };
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

async function findOptionalAgent(sourceAgent, templateID) {
  const userAgents = await store.readCollection('user-agents');
  return findDelegationTarget(userAgents, sourceAgent, { templateID }) || null;
}

async function buildGraphNodeReply(agent, event, options = {}) {
  if (options.allowTools) {
    const result = await buildAgentReply(agent, event, {
      runID: options.runID || `graph_${randomUUID()}`,
      workspaceID: options.workspaceID,
      allowDelegate: false,
      depth: 1,
    });
    return { ...result, mode: result.mode || 'langchain-agent', status: result.status || 'success', error: result.error || '' };
  }
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
    'localAgentProvider',
    'workerTemplateID',
    'workerAgentUserID',
  ]) {
    if (typeof body[key] === 'string') updates[key] = body[key].trim();
  }
  if (updates.runtime && !['openai-tools', 'langgraph-planner-worker', 'langchain-agent', 'langgraph-supervisor', 'local-cli-agent'].includes(updates.runtime)) {
    delete updates.runtime;
  }
  if (updates.localAgentProvider && !['codex', 'claude', 'opencode'].includes(updates.localAgentProvider)) {
    delete updates.localAgentProvider;
  }
  if (Array.isArray(body.enabledToolIDs)) {
    const validIDs = new Set(listTools().map((tool) => tool.toolID));
    updates.enabledToolIDs = body.enabledToolIDs.filter((id) => typeof id === 'string' && validIDs.has(id));
  }
  return updates;
}
