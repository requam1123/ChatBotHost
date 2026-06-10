export const AgentMessageKind = Object.freeze({
  Task: 'agent_task',
  Result: 'agent_result',
  Summary: 'agent_summary',
});

export const AgentContentType = Object.freeze({
  Task: 1301,
  Result: 1302,
  Summary: 1303,
});

export function isAgentProtocolContentType(contentType) {
  return Object.values(AgentContentType).includes(Number(contentType));
}

export function parseAgentMessagePayload(message = {}) {
  const contentType = Number(message.contentType || 0);
  if (!isAgentProtocolContentType(contentType)) return null;

  const contentPayload = parseJsonObject(message.content);
  const exPayload = parseJsonObject(message.ex);
  const attachedInfoPayload = parseJsonObject(message.attachedInfo);
  const payload = {
    ...(attachedInfoPayload || {}),
    ...(exPayload || {}),
    ...(contentPayload || {}),
  };

  const kind = payload.kind || kindFromContentType(contentType);
  if (!kind) return null;

  return {
    ...payload,
    kind,
    contentType,
    taskID: stringValue(payload.taskID),
    parentTaskID: stringValue(payload.parentTaskID),
    title: stringValue(payload.title),
    role: stringValue(payload.role),
    task: stringValue(payload.task),
    result: stringValue(payload.result),
    summary: stringValue(payload.summary),
    status: stringValue(payload.status || 'success'),
    sourceAgentUserID: stringValue(payload.sourceAgentUserID || message.sendID),
    sourceAgentNickname: stringValue(payload.sourceAgentNickname || message.senderNickname),
    requesterUserID: stringValue(payload.requesterUserID),
    replyToAgentUserID: stringValue(payload.replyToAgentUserID),
    targetAgentUserIDs: arrayOfStrings(payload.targetAgentUserIDs),
    targetAgentNicknames: arrayOfStrings(payload.targetAgentNicknames),
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
  };
}

export function buildAgentMessageContent(payload) {
  return JSON.stringify(compactObject(payload));
}

export function buildAgentTaskPayload({
  taskID,
  parentTaskID = '',
  title = '',
  role = '',
  task,
  context = '',
  sourceAgent,
  requesterUserID = '',
  targetAgents = [],
  metadata = {},
}) {
  return compactObject({
    kind: AgentMessageKind.Task,
    taskID,
    parentTaskID,
    title,
    role,
    task,
    context,
    sourceAgentUserID: sourceAgent?.imAgentUserID || '',
    sourceAgentID: sourceAgent?.userAgentID || '',
    sourceAgentNickname: sourceAgent?.nickname || sourceAgent?.templateID || '',
    requesterUserID,
    targetAgentUserIDs: targetAgents.map((agent) => agent.imAgentUserID).filter(Boolean),
    targetAgentNicknames: targetAgents.map((agent) => agent.nickname || agent.templateID).filter(Boolean),
    metadata,
  });
}

export function buildAgentResultPayload({
  taskID = '',
  parentTaskID = '',
  title = '',
  result,
  status = 'success',
  sourceAgent,
  replyToAgentUserID = '',
  requesterUserID = '',
  metadata = {},
}) {
  return compactObject({
    kind: AgentMessageKind.Result,
    taskID,
    parentTaskID,
    title,
    result,
    status,
    sourceAgentUserID: sourceAgent?.imAgentUserID || '',
    sourceAgentID: sourceAgent?.userAgentID || '',
    sourceAgentNickname: sourceAgent?.nickname || sourceAgent?.templateID || '',
    replyToAgentUserID,
    requesterUserID,
    metadata,
  });
}

export function buildAgentSummaryPayload({
  taskID = '',
  parentTaskID = '',
  title = '',
  summary,
  sourceAgent,
  requesterUserID = '',
  metadata = {},
}) {
  return compactObject({
    kind: AgentMessageKind.Summary,
    taskID,
    parentTaskID,
    title,
    summary,
    sourceAgentUserID: sourceAgent?.imAgentUserID || '',
    sourceAgentID: sourceAgent?.userAgentID || '',
    sourceAgentNickname: sourceAgent?.nickname || sourceAgent?.templateID || '',
    requesterUserID,
    metadata,
  });
}

export function agentPayloadToModelInput(payload, fallbackContent = '') {
  if (!payload) return fallbackContent;
  if (payload.kind === AgentMessageKind.Task) {
    return [
      `Agent task ${payload.taskID || '(no taskID)'}`,
      payload.title ? `Title: ${payload.title}` : '',
      payload.role ? `Your role: ${payload.role}` : '',
      payload.sourceAgentNickname || payload.sourceAgentUserID
        ? `Assigned by: ${payload.sourceAgentNickname || payload.sourceAgentUserID}`
        : '',
      payload.requesterUserID ? `Original requester: ${payload.requesterUserID}` : '',
      '',
      payload.task || fallbackContent,
      payload.context ? `\nContext:\n${payload.context}` : '',
      '',
      'When you finish, return the result directly. If the send_agent_result tool is available, use it to report back to the assigning agent.',
    ].filter(Boolean).join('\n');
  }
  if (payload.kind === AgentMessageKind.Result) {
    return [
      `Agent result ${payload.taskID || '(no taskID)'}`,
      payload.title ? `Title: ${payload.title}` : '',
      payload.sourceAgentNickname || payload.sourceAgentUserID
        ? `From: ${payload.sourceAgentNickname || payload.sourceAgentUserID}`
        : '',
      payload.requesterUserID ? `Original requester: ${payload.requesterUserID}` : '',
      payload.status ? `Status: ${payload.status}` : '',
      '',
      payload.result || fallbackContent,
      '',
      'Use the conversation history and any other available task results to decide whether to continue coordination or summarize to the requester.',
    ].filter(Boolean).join('\n');
  }
  if (payload.kind === AgentMessageKind.Summary) {
    return payload.summary || fallbackContent;
  }
  return fallbackContent;
}

export function formatAgentTaskDisplay(payload) {
  const target = payload.targetAgentNicknames?.length
    ? payload.targetAgentNicknames.map((name) => `@${name}`).join(' ')
    : payload.targetAgentUserIDs?.map((id) => `@${id}`).join(' ');
  return [
    target ? `${target} 任务分派` : '任务分派',
    payload.title ? `标题：${payload.title}` : '',
    payload.role ? `角色：${payload.role}` : '',
    payload.task || '',
    payload.context ? `\n上下文：\n${payload.context}` : '',
    payload.taskID ? `\nTaskID: ${payload.taskID}` : '',
  ].filter(Boolean).join('\n');
}

export function formatAgentResultDisplay(payload) {
  const prefix = payload.replyToAgentUserID ? `@${payload.replyToAgentUserID} ` : '';
  return [
    `${prefix}任务结果${payload.taskID ? ` (${payload.taskID})` : ''}`,
    payload.status && payload.status !== 'success' ? `状态：${payload.status}` : '',
    payload.result || '',
  ].filter(Boolean).join('\n');
}

export function formatAgentSummaryDisplay(payload) {
  const prefix = payload.requesterUserID ? `@${payload.requesterUserID} ` : '';
  return `${prefix}${payload.summary || ''}`.trim();
}

export function normalizeTaskID(value) {
  const text = stringValue(value);
  if (text) return text;
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function kindFromContentType(contentType) {
  if (contentType === AgentContentType.Task) return AgentMessageKind.Task;
  if (contentType === AgentContentType.Result) return AgentMessageKind.Result;
  if (contentType === AgentContentType.Summary) return AgentMessageKind.Summary;
  return '';
}

function parseJsonObject(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compactObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === undefined || item === null || item === '') continue;
    if (Array.isArray(item) && item.length === 0) continue;
    if (typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) continue;
    result[key] = item;
  }
  return result;
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}
