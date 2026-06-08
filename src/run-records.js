import { createHash, randomUUID } from 'node:crypto';

export function normalizeGraphSteps(steps = []) {
  return steps.map((step, index) => ({
    stepID: step.stepID || `step_${index + 1}_${randomUUID()}`,
    node: step.node || `step_${index + 1}`,
    status: step.status || 'success',
    agentID: step.agentID || '',
    agentUserID: step.agentUserID || '',
    agentNickname: step.agentNickname || '',
    input: step.input || '',
    output: step.output || '',
    serverMsgID: step.serverMsgID || '',
    provider: step.provider || '',
    endpoint: step.endpoint || '',
    model: step.model || '',
    toolCallIDs: step.toolCallIDs || extractToolCallIDs(step.toolCalls || []),
    toolCalls: step.toolCalls || [],
    startTime: step.startTime || step.time || Date.now(),
    endTime: step.endTime || step.time || Date.now(),
    time: step.time || step.endTime || step.startTime || Date.now(),
    durationMs: step.durationMs || duration(step.startTime, step.endTime),
    metadata: step.metadata || {},
  }));
}

export function normalizeToolCalls(toolCalls = []) {
  return toolCalls.map((call) => ({
    toolCallID: call.toolCallID || `tool_${randomUUID()}`,
    toolID: call.toolID || '',
    source: call.source || 'builtin',
    graphNode: call.graphNode || '',
    agentID: call.agentID || '',
    agentUserID: call.agentUserID || '',
    agentNickname: call.agentNickname || '',
    args: call.args || {},
    result: call.result || {},
    status: call.status || toolStatus(call),
    policyDecision: call.policyDecision || null,
    startTime: call.startTime || call.createTime || Date.now(),
    createTime: call.createTime || call.endTime || Date.now(),
    endTime: call.endTime || call.createTime || Date.now(),
    durationMs: call.durationMs || duration(call.startTime, call.createTime),
  }));
}

export function buildArtifactsFromToolCalls(toolCalls = []) {
  const writeArtifacts = toolCalls
    .filter((call) => call.toolID === 'workspace_write' && call.result?.ok && call.result?.path)
    .map((call) => ({
      artifactID: `artifact_${stableHash(`${call.toolCallID}:${call.result.path}`)}`,
      type: 'file',
      source: 'workspace',
      path: call.result.path,
      sandboxPath: call.result.path,
      targetPath: call.result.path,
      size: call.result.bytes || 0,
      contentHash: '',
      createToolCallID: call.toolCallID,
      agentID: call.agentID || '',
      agentUserID: call.agentUserID || '',
      agentNickname: call.agentNickname || '',
      status: 'sandbox',
      createTime: call.createTime || Date.now(),
    }));
  const localAgentArtifacts = toolCalls
    .filter((call) => call.toolID === 'local_agent_run' && call.result?.ok && Array.isArray(call.result.files))
    .flatMap((call) => call.result.files.map((file) => {
      const path = file.targetPath || file.sandboxPath || file.path;
      return {
        artifactID: `artifact_${stableHash(`${call.toolCallID}:${path}`)}`,
        type: 'file',
        source: 'local_agent',
        path,
        sandboxPath: file.sandboxPath || file.path || path,
        targetPath: file.targetPath || path,
        size: file.bytes || 0,
        contentHash: '',
        createToolCallID: call.toolCallID,
        agentID: call.agentID || '',
        agentUserID: call.agentUserID || '',
        agentNickname: call.agentNickname || '',
        status: file.status || 'sandbox',
        createTime: call.createTime || Date.now(),
      };
    }));
  return [...writeArtifacts, ...localAgentArtifacts];
}

export function normalizeArtifacts(artifacts = []) {
  const seen = new Set();
  const normalized = [];
  for (const artifact of artifacts) {
    const type = artifact.type || 'file';
    const key = [
      type,
      artifact.artifactID || '',
      artifact.proposalID || '',
      artifact.createToolCallID || '',
      artifact.targetPath || artifact.path || '',
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      ...artifact,
      artifactID: artifact.artifactID || `artifact_${stableHash(key)}`,
      type,
      source: artifact.source || (type === 'patch_proposal' ? 'approval' : 'workspace'),
      status: artifact.status || (type === 'patch_proposal' ? 'pending' : 'sandbox'),
      createTime: artifact.createTime || Date.now(),
    });
  }
  return normalized;
}

export function normalizeApprovals(approvals = []) {
  return approvals.map((approval) => ({
    approvalID: approval.approvalID || `approval_${randomUUID()}`,
    type: approval.type || 'patch',
    status: approval.status || 'pending',
    requestedByAgentID: approval.requestedByAgentID || '',
    approvedByUserID: approval.approvedByUserID || '',
    proposalID: approval.proposalID || '',
    createTime: approval.createTime || Date.now(),
    applyTime: approval.applyTime || approval.appliedTime || 0,
    files: approval.files || [],
  }));
}

function extractToolCallIDs(toolCalls) {
  return toolCalls.map((call) => call.toolCallID).filter(Boolean);
}

function toolStatus(call) {
  if (call.result?.ok === false) return 'failed';
  if (call.result?.ok === true) return 'success';
  return 'completed';
}

function duration(startTime, endTime) {
  if (typeof startTime !== 'number' || typeof endTime !== 'number') return 0;
  return Math.max(0, endTime - startTime);
}

function stableHash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}
