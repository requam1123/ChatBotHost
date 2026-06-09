import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { HttpError } from './http.js';
import { generateAgentReply, resolveProviderConfig } from './providers.js';
import { generateLangChainAgentReply } from './langchain-agent-runtime.js';
import { executeToolCall } from './tools.js';
import {
  buildArtifactsFromToolCalls,
  normalizeArtifacts,
  normalizeApprovals,
  normalizeGraphSteps,
  normalizeToolCalls,
} from './run-records.js';
import { resolveEventWorkspace } from './workspace-manager.js';

const log = createLogger('agent-reply');

let ctx = {};

export function initReplyServices({ store, imClient, config, langGraphRuntime }) {
  ctx = { store, imClient, config, langGraphRuntime };
}

export async function runMockAgentReply(runID, agent, event, _unused) {
  const { store, imClient, config } = ctx;
  log.info(`开始 Agent 回复: runID=${runID}, agent=${agent.nickname || agent.templateID}, runtime=${agent.runtime}, conversation=${event.conversationID}`);
  const workspaceContext = await resolveEventWorkspace({ store, config, event, ownerUserID: agent.ownerUserID });

  const startTime = Date.now();
  const result = await buildAgentReplyForRuntime(agent, event, {
    runID,
    rootRunID: runID,
    parentRunID: '',
    depth: 0,
    allowDelegate: true,
    ...workspaceContext,
  });
  const runResult = attachWorkspaceResult(result, workspaceContext);
  const replyText = runResult.content;

  log.info(`Agent 回复生成完毕: runtime=${runResult.runtime}, status=${runResult.status || 'unknown'}, contentLength=${replyText?.length || 0}, toolCalls=${runResult.toolCalls?.length || 0}, elapsed=${Date.now() - startTime}ms`);

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
    result: runResult,
    startTime,
    endTime,
  }));
  await store.writeCollection('agent-runs', runs);
}

export async function buildAgentReplyForRuntime(agent, event, runContext = {}) {
  return buildAgentReply(agent, event, runContext);
}

async function buildAgentReply(agent, event, runContext = {}) {
  const { store, imClient, config } = ctx;
  try {
    return await generateLangChainAgentReply(store, agent, event, {
      runID: runContext.runID,
      workspaceID: runContext.workspaceID,
      workspacePath: runContext.workspacePath,
      imClient,
      delegateToAgent: (delegation) => delegateToAgent(agent, event, runContext, delegation),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LangChain agent failed';
    log.error(`LangChain agent 失败，回退到 provider loop: ${message}`);
    try {
      const result = await generateAgentReply(store, agent, event, {
        toolExecutor: (toolID, args, context) => executeToolCall(toolID, args, {
          ...context,
          imClient,
          runContext,
          workspaceRoot: config.workspaceRoot,
          runID: runContext.runID,
          workspaceID: runContext.workspaceID,
          workspacePath: runContext.workspacePath,
          enabledToolIDs: agent.enabledToolIDs || [],
          delegateToAgent: (delegation) => delegateToAgent(agent, event, runContext, delegation),
        }),
      });
      return { ...result, mode: 'provider', status: 'success', error: '' };
    } catch (fallbackErr) {
      const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : message;
      log.error(`Provider 调用失败，回退到 mock reply: ${fallbackMessage}`);
      return {
        content: `${agent.nickname} 暂时无法连接模型，已收到你的消息：${event.content}`,
        mode: 'fallback',
        status: 'failed',
        provider: '',
        endpoint: '',
        model: '',
        toolCalls: [],
        error: fallbackMessage,
      };
    }
  }
}

async function buildLangGraphAgentReply(agent, event) {
  const { store, langGraphRuntime } = ctx;
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
    model: result.steps.find((step) => step.model)?.model || (await resolveProviderConfig(store, agent)).model,
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

export async function buildGraphNodeReply(agent, event, options = {}) {
  const { store } = ctx;
  if (options.allowTools) {
    const result = await buildAgentReplyForRuntime(agent, event, {
      runID: options.runID || `graph_${randomUUID()}`,
      workspaceID: options.workspaceID,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      targetPath: options.targetPath,
      allowDelegate: false,
      depth: 1,
    });
    return { ...result, mode: result.mode || 'langchain-agent', status: result.status || 'success', error: result.error || '' };
  }
  const result = await generateAgentReply(store, {
    ...agent,
    enabledToolIDs: [],
  }, event, {});
  return { ...result, mode: 'langgraph', status: 'success', error: '' };
}

export async function delegateToAgent(sourceAgent, event, runContext, delegation) {
  const { store } = ctx;
  if (!runContext.allowDelegate || runContext.depth >= 1) {
    return { ok: false, error: 'Delegation depth limit reached' };
  }

  const userAgents = await store.readCollection('agents');
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
    workspaceID: runContext.workspaceID,
    workspaceName: runContext.workspaceName,
    workspacePath: runContext.workspacePath,
    targetPath: runContext.targetPath,
  });
  const runResult = attachWorkspaceResult(result, runContext);
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
    result: runResult,
    startTime,
    endTime,
  }));
  await store.writeCollection('agent-runs', runs);

  return {
    ok: runResult.status === 'success',
    childRunID,
    delegatedToAgentID: targetAgent.userAgentID,
    delegatedToAgentUserID: targetAgent.imAgentUserID,
    task: delegation.task,
    output: runResult.content,
    durationMs: endTime - startTime,
    error: runResult.error || '',
  };
}

export function findDelegationTarget(userAgents, sourceAgent, delegation) {
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

export function buildDelegationContent(delegation) {
  if (!delegation.context) return delegation.task;
  return `${delegation.task}\n\nContext:\n${delegation.context}`;
}

export function buildRunRecord({
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
    model: result.model,
    workspaceID: result.workspaceID || '',
    workspaceName: result.workspaceName || '',
    workspacePath: result.workspacePath || '',
    workspaceTargetPath: result.workspaceTargetPath || '',
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

export function attachWorkspaceResult(result, workspaceContext = {}) {
  return {
    ...result,
    workspaceID: workspaceContext.workspaceID || result.workspaceID || '',
    workspaceName: workspaceContext.workspaceName || result.workspaceName || '',
    workspacePath: workspaceContext.workspacePath || result.workspacePath || '',
    workspaceTargetPath: workspaceContext.targetPath || result.workspaceTargetPath || '',
  };
}

export async function requireWorkerAgent(plannerAgent, body) {
  const { store } = ctx;
  const userAgents = await store.readCollection('agents');
  const worker = findDelegationTarget(userAgents, plannerAgent, {
    agentUserID: typeof body.agentUserID === 'string' ? body.agentUserID.trim() : '',
    templateID: typeof body.templateID === 'string' ? body.templateID.trim() : 'coder',
  });
  if (!worker) throw new HttpError(404, 'Worker agent not found');
  return worker;
}

export async function findOptionalAgent(sourceAgent, templateID) {
  const { store } = ctx;
  const userAgents = await store.readCollection('agents');
  return findDelegationTarget(userAgents, sourceAgent, { templateID }) || null;
}

export function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncateText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}
