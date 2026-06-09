import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { HttpError } from './http.js';
import { resolveProviderConfig } from './providers.js';
import {
  buildArtifactsFromToolCalls,
  normalizeArtifacts,
  normalizeApprovals,
  normalizeGraphSteps,
  normalizeToolCalls,
} from './run-records.js';
import {
  attachWorkspaceResult,
  buildGraphNodeReply,
  buildRunRecord,
  findDelegationTarget,
  findOptionalAgent,
  requireWorkerAgent,
} from './agent-reply.js';

const log = createLogger('group-collab');

let ctx = {};

export function initGroupCollaborationServices({ store, imClient, langGraphSupervisorRuntime }) {
  ctx = { store, imClient, langGraphSupervisorRuntime };
}

export async function handleGroupPlanConfirmation(runID, plannerAgent, event, workspaceContext = {}) {
  const { store } = ctx;
  const pendingPlans = await store.readCollection('pending-plans');
  const pendingIndex = findLatestPendingPlanIndex(pendingPlans, plannerAgent, event);

  if (pendingIndex >= 0 && isPlanConfirmation(event.content)) {
    const pending = pendingPlans[pendingIndex];
    pendingPlans[pendingIndex] = {
      ...pending,
      status: 'approved',
      approvedServerMsgID: event.serverMsgID,
      approvedTime: Date.now(),
    };
    await store.writeCollection('pending-plans', pendingPlans);
    await runVisibleGroupCollaboration(runID, plannerAgent, {
      ...event,
      content: pending.task,
    }, workspaceContext);
    return true;
  }

  if (!wantsPlanConfirmation(event.content)) return false;

  const { workerAgent, reviewerAgent, selectionReason } = await resolveGroupCollaborationAgents(plannerAgent, event);
  const mentionNames = [plannerAgent.nickname, workerAgent.nickname, reviewerAgent?.nickname].filter(Boolean);
  const cleanTask = stripMentionText(event.content, mentionNames);
  const planText = [
    `@${event.sendID} 收到，我先给方案，等你确认后再让 ${workerAgent.nickname} 开始实现。`,
    '',
    '方案：',
    '1. 做一个简单计算器的最小可用版本，先支持加、减、乘、除。',
    '2. 交付一个单文件实现，包含清晰输入、计算逻辑和基础错误处理。',
    '3. 由执行 Agent 在 sandbox 内生成文件并做一次最小验证。',
    '4. 生成完成后我汇总结果；真实写入仓库仍走 Patch 审批。',
    '',
    `执行 Agent：${workerAgent.nickname}`,
    `选择理由：${selectionReason}`,
    '',
    '请回复 @Planner Agent 确认开始，我再继续执行。',
  ].join('\n');
  const sent = await sendGroupText(plannerAgent, event.groupID, planText, [event.sendID]);
  const now = Date.now();
  pendingPlans.push({
    pendingPlanID: `pending_${randomUUID()}`,
    status: 'pending',
    runID,
    ownerUserID: plannerAgent.ownerUserID,
    groupID: event.groupID,
    plannerAgentID: plannerAgent.userAgentID,
    plannerAgentUserID: plannerAgent.imAgentUserID,
    requesterID: event.sendID,
    requestServerMsgID: event.serverMsgID,
    responseServerMsgID: sent.serverMsgID,
    workerAgentID: workerAgent.userAgentID,
    workerAgentUserID: workerAgent.imAgentUserID,
    task: cleanTask,
    planText,
    createTime: now,
  });
  await store.writeCollection('pending-plans', pendingPlans);

  const runs = await store.readCollection('agent-runs');
  runs.push(buildRunRecord({
    runID,
    responseServerMsgID: sent.serverMsgID,
    output: {
      sendID: plannerAgent.imAgentUserID,
      recvID: event.sendID,
      groupID: event.groupID,
      content: planText,
      serverMsgID: sent.serverMsgID,
    },
    agent: plannerAgent,
    event,
    result: {
      content: planText,
      mode: 'langgraph-visible',
      runtime: 'langgraph-planner-worker',
      status: 'success',
      provider: plannerAgent.provider || '',
      endpoint: plannerAgent.endpoint || '',
      model: (await resolveProviderConfig(store, plannerAgent)).model,
      toolCalls: [],
      graphSteps: [{
        node: 'planner_plan_confirmation',
        agentID: plannerAgent.userAgentID,
        agentUserID: plannerAgent.imAgentUserID,
        agentNickname: plannerAgent.nickname,
        output: planText,
        serverMsgID: sent.serverMsgID,
        startTime: now,
        endTime: now,
        time: now,
      }],
      workerAgentID: workerAgent.userAgentID,
      workerAgentUserID: workerAgent.imAgentUserID,
      workerTemplateID: workerAgent.templateID,
      workspaceID: workspaceContext.workspaceID || '',
      workspaceName: workspaceContext.workspaceName || '',
      workspacePath: workspaceContext.workspacePath || '',
      workspaceTargetPath: workspaceContext.targetPath || '',
      finalOutput: planText,
      error: '',
    },
    startTime: now,
    endTime: now,
  }));
  await store.writeCollection('agent-runs', runs);
  return true;
}

function findLatestPendingPlanIndex(pendingPlans, plannerAgent, event) {
  for (let index = pendingPlans.length - 1; index >= 0; index -= 1) {
    const plan = pendingPlans[index];
    if (
      plan.status === 'pending' &&
      plan.groupID === event.groupID &&
      plan.plannerAgentID === plannerAgent.userAgentID &&
      plan.requesterID === event.sendID
    ) {
      return index;
    }
  }
  return -1;
}

function wantsPlanConfirmation(content) {
  return /确认后|确认之后|先.*方案|先.*计划|让我确认|等.*确认/.test(content || '');
}

function isPlanConfirmation(content) {
  return /确认|同意|开始|执行|可以|按这个/.test(content || '');
}

export async function runVisibleGroupCollaboration(runID, plannerAgent, event, workspaceContext = {}) {
  const { langGraphSupervisorRuntime } = ctx;
  if (langGraphSupervisorRuntime.available && langGraphSupervisorRuntime.runVisibleSupervisorGraph) {
    try {
      await runVisibleGroupCollaborationWithSupervisor(runID, plannerAgent, event, workspaceContext);
      return;
    } catch (err) {
      log.error(`LangGraph supervisor 协作失败，回退到 legacy flow: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await runVisibleGroupCollaborationLegacy(runID, plannerAgent, event, workspaceContext);
}

async function runVisibleGroupCollaborationLegacy(runID, plannerAgent, event, workspaceContext = {}) {
  const { store } = ctx;
  const startTime = Date.now();
  const { workerAgent, reviewerAgent, selectionReason } = await resolveGroupCollaborationAgents(plannerAgent, event);

  const mentionNames = [plannerAgent.nickname, workerAgent.nickname, reviewerAgent?.nickname].filter(Boolean);
  const cleanTask = stripMentionText(event.content, mentionNames);
  const plannerAck = reviewerAgent
    ? `@${event.sendID} 收到，我先规划一下：\n1. 代码实现交给 Coder\n2. Coder 完成后 @我 回传代码\n3. 我再 @Reviewer 做代码审查\n4. 我最后 @${event.sendID} 汇总最终结果`
    : `@${event.sendID} 收到，我先规划一下：\n1. 代码实现交给 Coder\n2. Coder 完成后 @我 回传代码\n3. 我最后 @${event.sendID} 汇总最终结果`;
  const plannerAckMsg = await sendGroupText(plannerAgent, event.groupID, plannerAck, [event.sendID]);

  const plannerDelegate = `@${workerAgent.nickname} 请完成这个代码任务：${cleanTask}\n\n选择理由：${selectionReason}`;
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
  }, { runID: workerRunID, ...workspaceContext, allowTools: true });
  const workerEndTime = Date.now();
  const workerValidation = validateWorkerResult(workerResult);

  const coderResultText = workerValidation.ok
    ? `@${plannerAgent.nickname} 我完成了代码实现：\n\n${workerResult.content}`
    : `@${plannerAgent.nickname} 执行失败/无产物：\n\n${workerValidation.message}\n\n${workerResult.content}`;
  const coderResultMsg = await sendGroupText(workerAgent, event.groupID, coderResultText, [plannerAgent.imAgentUserID]);

  let reviewerAckMsg = null;
  let reviewerResultMsg = null;
  let reviewerResult = null;
  const allToolCalls = tagToolCalls(workerResult.toolCalls || [], 'worker', workerAgent);
  const resultGraphExtraSteps = [];
  if (reviewerAgent && workerValidation.ok) {
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
    }, { runID: reviewerRunID, ...workspaceContext, allowTools: true });
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

  const summaryTask = workerValidation.ok
    ? `Coder 已完成代码实现${reviewerResult ? '，Reviewer 已完成审查' : ''}，请你面向用户总结最终结果，并保留核心代码。\n\n用户原始任务：\n${cleanTask}\n\nCoder 输出：\n${workerResult.content}${reviewerResult ? `\n\nReviewer 输出：\n${reviewerResult.content}` : ''}`
    : `执行 Agent 没有产生可交付产物。请面向用户总结失败原因，不要声称任务已经完成。\n\n用户原始任务：\n${cleanTask}\n\n校验结果：\n${workerValidation.message}\n\nWorker 输出：\n${workerResult.content}`;
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
    status: workerValidation.ok ? 'success' : 'failed',
    provider: summaryResult.provider || workerResult.provider || plannerAgent.provider || '',
    endpoint: summaryResult.endpoint || workerResult.endpoint || plannerAgent.endpoint || '',
    model: summaryResult.model || workerResult.model || (await resolveProviderConfig(store, plannerAgent)).model,
    toolCalls: [],
    error: workerValidation.ok ? '' : workerValidation.message,
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
    workspaceID: workspaceContext.workspaceID || '',
    workspaceName: workspaceContext.workspaceName || '',
    workspacePath: workspaceContext.workspacePath || '',
    workspaceTargetPath: workspaceContext.targetPath || '',
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

async function runVisibleGroupCollaborationWithSupervisor(runID, plannerAgent, event, workspaceContext = {}) {
  const { store, langGraphSupervisorRuntime } = ctx;
  const startTime = Date.now();
  const { workerAgent, reviewerAgent, selectionReason } = await resolveGroupCollaborationAgents(plannerAgent, event);
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
    workspaceContext,
    selectionReason,
    nodes: {
      plannerAck: async (state) => {
        const plannerAck = state.reviewerAgent
          ? `@${state.event.sendID} 收到，我先规划一下：\n1. 我会先确认需求和方案\n2. 执行交给 ${state.workerAgent.nickname}\n3. ${state.workerAgent.nickname} 完成后 @我 回传结果\n4. 我再 @Reviewer 做审查\n5. 我最后 @${state.event.sendID} 汇总最终结果`
          : `@${state.event.sendID} 收到，我先规划一下：\n1. 我会先确认需求和方案\n2. 执行交给 ${state.workerAgent.nickname}\n3. ${state.workerAgent.nickname} 完成后 @我 回传结果\n4. 我最后 @${state.event.sendID} 汇总最终结果`;
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
        const plannerDelegate = `@${state.workerAgent.nickname} 请完成这个代码任务：${state.cleanTask}\n\n选择理由：${state.selectionReason}`;
        const delegateMsg = await sendGroupText(state.plannerAgent, state.event.groupID, plannerDelegate, [state.workerAgent.imAgentUserID]);
        const workerAck = `@${state.plannerAgent.nickname} 收到，我开始执行，并会把结果回传给你。`;
        const ackMsg = await sendGroupText(state.workerAgent, state.event.groupID, workerAck, [state.plannerAgent.imAgentUserID]);
        const time = Date.now();
        return {
          plannerDelegate,
          workerAck,
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
              output: workerAck,
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
        }, { runID: `${state.runID}_worker`, ...state.workspaceContext, allowTools: true });
        const taggedToolCalls = tagToolCalls(workerResult.toolCalls || [], 'worker', state.workerAgent);
        const workerValidation = validateWorkerResult(workerResult);
        const workerResultText = workerValidation.ok
          ? `@${state.plannerAgent.nickname} 我完成了执行：\n\n${workerResult.content}`
          : `@${state.plannerAgent.nickname} 执行失败/无产物：\n\n${workerValidation.message}\n\n${workerResult.content}`;
        const resultMsg = await sendGroupText(state.workerAgent, state.event.groupID, workerResultText, [state.plannerAgent.imAgentUserID]);
        const nodeEndTime = Date.now();
        return {
          workerOutput: workerResult.content,
          workerValidation,
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
        const reviewTask = `请审查下面的实现，重点关注正确性、边界条件、类型设计、可维护性，并给出是否可交付的结论。\n\n用户任务：\n${state.cleanTask}\n\n${state.workerAgent.nickname} 输出：\n${state.workerOutput}`;
        const reviewerResult = await buildGraphNodeReply(state.reviewerAgent, {
          ...state.event,
          sendID: state.plannerAgent.imAgentUserID,
          recvID: state.reviewerAgent.imAgentUserID,
          content: reviewTask,
          serverMsgID: '',
        }, { runID: `${state.runID}_reviewer`, ...state.workspaceContext, allowTools: true });
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
        const summaryTask = state.workerValidation?.ok === false
          ? `执行 Agent 没有产生可交付产物。请面向用户总结失败原因，不要声称任务已经完成。\n\n用户原始任务：\n${state.cleanTask}\n\n校验结果：\n${state.workerValidation.message}\n\nWorker 输出：\n${state.workerOutput}`
          : `${state.workerAgent.nickname} 已完成代码实现${state.reviewerOutput ? '，Reviewer 已完成审查' : ''}，请你面向用户总结最终结果，并保留核心代码。\n\n用户原始任务：\n${state.cleanTask}\n\n${state.workerAgent.nickname} 输出：\n${state.workerOutput}${state.reviewerOutput ? `\n\nReviewer 输出：\n${state.reviewerOutput}` : ''}`;
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
    status: graphResult.workerValidation?.ok === false ? 'failed' : 'success',
    provider: plannerAgent.provider || '',
    endpoint: plannerAgent.endpoint || '',
    model: (await resolveProviderConfig(store, plannerAgent)).model,
    toolCalls,
    graphSteps: normalizeGraphSteps(graphResult.graphSteps || []),
    artifacts: buildArtifactsFromToolCalls(toolCalls),
    approvals: [],
    error: graphResult.workerValidation?.ok === false ? graphResult.workerValidation.message : '',
    workerAgentID: workerAgent.userAgentID,
    workerAgentUserID: workerAgent.imAgentUserID,
    workerTemplateID: workerAgent.templateID,
    workerOutput: graphResult.workerOutput,
    finalOutput: graphResult.finalOutput,
    workspaceID: workspaceContext.workspaceID || '',
    workspaceName: workspaceContext.workspaceName || '',
    workspacePath: workspaceContext.workspacePath || '',
    workspaceTargetPath: workspaceContext.targetPath || '',
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

function validateWorkerResult(workerResult) {
  if (!workerResult || workerResult.status === 'failed') {
    return { ok: false, message: workerResult?.error || 'Worker execution failed' };
  }
  const toolCalls = Array.isArray(workerResult.toolCalls) ? workerResult.toolCalls : [];
  if (toolCalls.length === 0) {
    return { ok: true, message: 'Worker returned natural language output without tool trace' };
  }

  const failedExit = toolCalls.find((call) =>
    Number.isFinite(call.result?.exitCode) && call.result.exitCode !== 0
  );
  if (failedExit) {
    return { ok: false, message: `Tool ${failedExit.toolID} failed with exitCode ${failedExit.result.exitCode}` };
  }

  const hasWorkspaceWrite = toolCalls.some((call) =>
    call.toolID === 'workspace_write' && call.result?.ok && call.result?.path
  );
  const hasStdoutOrStderr = toolCalls.some((call) =>
    typeof call.result?.stdout === 'string' && call.result.stdout.trim() ||
    typeof call.result?.stderr === 'string' && call.result.stderr.trim()
  );
  const hasSuccessfulToolTrace = toolCalls.some((call) => call.result?.ok);

  if (!hasSuccessfulToolTrace) {
    return { ok: false, message: 'Worker did not produce any successful tool trace' };
  }
  if (!hasWorkspaceWrite && !hasStdoutOrStderr) {
    return { ok: false, message: 'Worker produced no stdout/stderr and no file changes' };
  }
  return { ok: true, message: 'Worker produced verifiable tool output' };
}

async function sendGroupText(agent, groupID, content, atUserIDList = []) {
  const { imClient } = ctx;
  return imClient.sendMessage({
    sendID: agent.imAgentUserID,
    groupID,
    content,
    atUserIDList,
    senderNickname: agent.nickname,
    senderFaceURL: agent.avatarURL,
  });
}

export async function sendGroupCollaborationError(runID, plannerAgent, event, err, workspaceContext = {}) {
  const { store } = ctx;
  const message = err instanceof Error ? err.message : '群聊协作启动失败';
  const content = `@${event.sendID} ${message}`;
  const sent = await sendGroupText(plannerAgent, event.groupID, content, [event.sendID]);
  const now = Date.now();
  const runs = await store.readCollection('agent-runs');
  runs.push(buildRunRecord({
    runID,
    responseServerMsgID: sent.serverMsgID,
    output: {
      sendID: plannerAgent.imAgentUserID,
      recvID: event.sendID,
      groupID: event.groupID,
      content,
      serverMsgID: sent.serverMsgID,
    },
    agent: plannerAgent,
    event,
    result: {
      content,
      mode: 'langgraph-visible',
      runtime: plannerAgent.runtime || 'langgraph-planner-worker',
      status: 'failed',
      provider: plannerAgent.provider || '',
      endpoint: plannerAgent.endpoint || '',
      model: (await resolveProviderConfig(store, plannerAgent)).model,
      toolCalls: [],
      graphSteps: [{
        node: 'planner_error',
        agentID: plannerAgent.userAgentID,
        agentUserID: plannerAgent.imAgentUserID,
        agentNickname: plannerAgent.nickname,
        output: content,
        serverMsgID: sent.serverMsgID,
        startTime: now,
        endTime: now,
        time: now,
      }],
      workspaceID: workspaceContext.workspaceID || '',
      workspaceName: workspaceContext.workspaceName || '',
      workspacePath: workspaceContext.workspacePath || '',
      workspaceTargetPath: workspaceContext.targetPath || '',
      finalOutput: content,
      error: message,
    },
    startTime: now,
    endTime: now,
  }));
  await store.writeCollection('agent-runs', runs);
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

async function resolveGroupCollaborationAgents(plannerAgent, event) {
  const { store } = ctx;
  const userAgents = await store.readCollection('agents');
  const groupAgents = await findGroupAgents(plannerAgent, event, userAgents);
  const mentionedWorker = groupAgents.find((agent) =>
    agent.imAgentUserID !== plannerAgent.imAgentUserID &&
    agent.templateID !== 'reviewer' &&
    event.atUserIDList?.includes(agent.imAgentUserID)
  );
  const coderWorker = groupAgents.find((agent) =>
    agent.imAgentUserID !== plannerAgent.imAgentUserID &&
    agent.templateID === 'coder'
  );
  const anyWorker = groupAgents.find((agent) =>
    agent.imAgentUserID !== plannerAgent.imAgentUserID &&
    agent.templateID !== 'reviewer'
  );
  const groupWorker = mentionedWorker || coderWorker || anyWorker;
  if (event.groupID && !groupWorker) {
    throw new HttpError(400, '这个群里还没有可执行的 Agent。请先把 Claude Code、Codex CLI、OpenCode 或 Coder 拉进群，再 @Planner Agent 分配任务。');
  }
  const executableCount = groupAgents.filter((agent) =>
    agent.imAgentUserID !== plannerAgent.imAgentUserID &&
    agent.templateID !== 'reviewer'
  ).length;
  const workerAgent = groupWorker || await requireWorkerAgent(plannerAgent, {
    agentUserID: plannerAgent.workerAgentUserID || '',
    templateID: plannerAgent.workerTemplateID || 'coder',
  });
  const selectionReason = buildWorkerSelectionReason({
    workerAgent,
    mentionedWorker,
    coderWorker,
    executableCount,
    hasGroup: Boolean(event.groupID),
  });
  const reviewerAgent = event.groupID
    ? groupAgents.find((agent) => agent.templateID === 'reviewer') || null
    : await findOptionalAgent(plannerAgent, 'reviewer');
  return { workerAgent, reviewerAgent, selectionReason };
}

function buildWorkerSelectionReason({ workerAgent, mentionedWorker, coderWorker, executableCount, hasGroup }) {
  const prefix = hasGroup ? `当前群里有 ${executableCount} 个可执行 Agent。` : '';
  if (mentionedWorker && workerAgent.userAgentID === mentionedWorker.userAgentID) {
    return `${prefix}用户消息中显式 @ 了 ${workerAgent.nickname}，所以由它执行。`;
  }
  if (coderWorker && workerAgent.userAgentID === coderWorker.userAgentID) {
    return `${prefix}${workerAgent.nickname} 是群里的 Coder Agent，匹配代码实现任务。`;
  }
  return `${prefix}选择群内第一个可执行 Agent：${workerAgent.nickname}。`;
}

async function findGroupAgents(plannerAgent, event, userAgents) {
  const { store, imClient } = ctx;
  if (!event.groupID) return [];
  try {
    const members = await imClient.getGroupMembers(event.groupID, plannerAgent.ownerUserID);
    const memberIDs = new Set(members.map((member) => member.userID).filter(Boolean));
    return userAgents.filter((agent) =>
      agent.ownerUserID === plannerAgent.ownerUserID &&
      memberIDs.has(agent.imAgentUserID)
    );
  } catch (err) {
    log.error(`解析群组 Agent 失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
