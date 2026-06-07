export const toolCatalog = [
  {
    toolID: 'get_current_time',
    name: 'Get Current Time',
    description: 'Return the current server time and timezone.',
    category: 'safe_read',
    riskLevel: 'low',
    source: 'builtin',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    enabled: true,
  },
  {
    toolID: 'read_conversation_messages',
    name: 'Read Conversation Messages',
    description: 'Read recent messages from the current IM conversation.',
    category: 'safe_read',
    riskLevel: 'low',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        conversationID: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['conversationID'],
      additionalProperties: false,
    },
    enabled: true,
  },
  {
    toolID: 'send_im_message',
    name: 'Send IM Message',
    description: 'Send a message through the IM server as the current agent.',
    category: 'external_api',
    riskLevel: 'medium',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        conversationID: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['conversationID', 'content'],
      additionalProperties: false,
    },
    enabled: true,
  },
  {
    toolID: 'workspace_read',
    name: 'Workspace Read',
    description: 'Read files from a scoped agent workspace.',
    category: 'workspace_read',
    riskLevel: 'high',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    enabled: false,
  },
  {
    toolID: 'workspace_write',
    name: 'Workspace Write',
    description: 'Write files inside a scoped agent workspace.',
    category: 'workspace_write',
    riskLevel: 'critical',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    enabled: false,
  },
  {
    toolID: 'bash',
    name: 'Bash',
    description: 'Run shell commands in a future sandboxed workspace.',
    category: 'shell',
    riskLevel: 'critical',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
    enabled: false,
  },
];

export function listTools({ template } = {}) {
  const allowedIDs = template?.defaultToolIDs ? new Set(template.defaultToolIDs) : null;
  return toolCatalog
    .filter((tool) => tool.enabled)
    .filter((tool) => !allowedIDs || allowedIDs.has(tool.toolID));
}

export function findTools(toolIDs) {
  const idSet = new Set(toolIDs);
  return toolCatalog.filter((tool) => idSet.has(tool.toolID) && tool.enabled);
}

export function toOpenAITools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.toolID,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export async function executeToolCall(toolID, args, context) {
  if (!context.enabledToolIDs?.includes(toolID)) {
    return { ok: false, error: `Tool is not enabled for this agent: ${toolID}` };
  }

  switch (toolID) {
    case 'get_current_time':
      return {
        ok: true,
        time: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    case 'read_conversation_messages':
      return readConversationMessages(args, context);
    case 'send_im_message':
      return sendImMessage(args, context);
    default:
      return { ok: false, error: `Tool is not implemented: ${toolID}` };
  }
}

async function readConversationMessages(args, context) {
  const requestedConversationID = typeof args.conversationID === 'string' ? args.conversationID.trim() : '';
  const conversationID = isCurrentConversationAlias(requestedConversationID)
    ? context.event.conversationID
    : requestedConversationID;
  const limit = clampInteger(args.limit, 10, 1, 50);
  const token = await context.imClient.getToken(context.agent.imAgentUserID);
  const data = await context.imClient.post('/msg/search_msg', {
    conversationID,
    pageNumber: 1,
    showNumber: limit,
  }, token);

  const messages = (data.chatLogs || [])
    .map((item) => item.chatLog || item)
    .reverse()
    .map((msg) => ({
      sendID: msg.sendID,
      recvID: msg.recvID,
      content: msg.content,
      sendTime: msg.sendTime,
      serverMsgID: msg.serverMsgID,
    }));

  return { ok: true, conversationID, messages };
}

function isCurrentConversationAlias(value) {
  return !value || ['current', 'current_conversation', 'this_conversation'].includes(value);
}

async function sendImMessage(args, context) {
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!content) return { ok: false, error: 'content is required' };

  const sent = await context.imClient.sendMessage({
    sendID: context.agent.imAgentUserID,
    recvID: context.event.sendID,
    content,
    senderNickname: context.agent.nickname,
    senderFaceURL: context.agent.avatarURL,
  });

  return {
    ok: true,
    serverMsgID: sent.serverMsgID,
    conversationID: sent.conversationID || context.event.conversationID,
  };
}

function clampInteger(value, defaultValue, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}
