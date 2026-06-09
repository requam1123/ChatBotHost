import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';

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
    toolID: 'delegate_to_agent',
    name: 'Delegate To Agent',
    description: 'Delegate a task to another agent owned by the same user and return the worker result.',
    category: 'external_api',
    riskLevel: 'medium',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        agentUserID: { type: 'string' },
        templateID: { type: 'string' },
        task: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['task'],
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
      properties: {
        path: { type: 'string' },
        maxChars: { type: 'number', minimum: 1000, maximum: 100000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    enabled: true,
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
    enabled: true,
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
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number', minimum: 1000, maximum: 30000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    enabled: true,
  },
  {
    toolID: 'local_agent_run',
    name: 'Local Agent Run',
    description: 'Run a locally configured coding CLI agent such as codex, claude, or opencode inside the scoped sandbox workspace.',
    category: 'shell',
    riskLevel: 'critical',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['codex', 'claude', 'opencode'] },
        task: { type: 'string' },
        model: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number', minimum: 10000, maximum: 600000 },
      },
      required: ['provider', 'task'],
      additionalProperties: false,
    },
    enabled: true,
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
    case 'delegate_to_agent':
      return delegateToAgent(args, context);
    case 'workspace_read':
      return workspaceRead(args, context);
    case 'workspace_write':
      return workspaceWrite(args, context);
    case 'bash':
      return runBash(args, context);
    case 'local_agent_run':
      return runLocalAgent(args, context);
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

async function delegateToAgent(args, context) {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) return { ok: false, error: 'task is required' };
  if (!context.delegateToAgent) return { ok: false, error: 'Delegation is not available in this runtime' };

  return context.delegateToAgent({
    agentUserID: typeof args.agentUserID === 'string' ? args.agentUserID.trim() : '',
    templateID: typeof args.templateID === 'string' ? args.templateID.trim() : '',
    task,
    context: typeof args.context === 'string' ? args.context.trim() : '',
  });
}

async function workspaceRead(args, context) {
  const workspace = await requireBoundWorkspace(context);
  if (!workspace.ok) return workspace;
  const root = workspace.path;
  const target = resolveWorkspacePath(root, args.path);
  if (!target.ok) return target;

  try {
    const content = await readFile(target.path, 'utf8');
    const maxChars = clampInteger(args.maxChars, 20000, 1000, 100000);
    return {
      ok: true,
      path: target.relativePath,
      content: content.slice(0, maxChars),
      truncated: content.length > maxChars,
      bytes: Buffer.byteLength(content),
    };
  } catch (err) {
    return {
      ok: false,
      path: target.relativePath,
      error: err instanceof Error ? err.message : 'Failed to read file',
    };
  }
}

async function workspaceWrite(args, context) {
  const content = typeof args.content === 'string' ? args.content : '';
  const workspace = await requireBoundWorkspace(context);
  if (!workspace.ok) return workspace;
  const root = workspace.path;
  const target = resolveWorkspacePath(root, args.path);
  if (!target.ok) return target;

  try {
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, content, 'utf8');
    return {
      ok: true,
      path: target.relativePath,
      bytes: Buffer.byteLength(content),
    };
  } catch (err) {
    return {
      ok: false,
      path: target.relativePath,
      error: err instanceof Error ? err.message : 'Failed to write file',
    };
  }
}

async function runBash(args, context) {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return { ok: false, error: 'command is required' };
  if (!context.enabledToolIDs?.includes('workspace_write') && looksMutatingShellCommand(command)) {
    return {
      ok: false,
      command,
      error: 'bash is read-only for this agent; mutating shell commands require workspace_write',
    };
  }
  const workspace = await requireBoundWorkspace(context);
  if (!workspace.ok) return workspace;
  const root = workspace.path;
  const cwdTarget = resolveWorkspacePath(root, typeof args.cwd === 'string' ? args.cwd : '.');
  if (!cwdTarget.ok) return cwdTarget;
  const timeoutMs = clampInteger(args.timeoutMs, 10000, 1000, 30000);

  return new Promise((resolvePromise) => {
    const startTime = Date.now();
    const child = spawn(command, {
      cwd: cwdTarget.path,
      shell: true,
      env: {
        ...process.env,
        npm_config_update_notifier: 'false',
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const maxOutput = 20000;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk.toString(), maxOutput);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), maxOutput);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        command,
        cwd: cwdTarget.relativePath || '.',
        error: err.message,
        durationMs: Date.now() - startTime,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0 && !timedOut,
        command,
        cwd: cwdTarget.relativePath || '.',
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

async function runLocalAgent(args, context) {
  const provider = typeof args.provider === 'string' ? args.provider.trim() : '';
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!['codex', 'claude', 'opencode'].includes(provider)) {
    return { ok: false, error: 'provider must be one of: codex, claude, opencode' };
  }
  if (!task) return { ok: false, error: 'task is required' };
  if (!context.enabledToolIDs?.includes('workspace_write')) {
    return {
      ok: false,
      provider,
      error: 'local_agent_run requires workspace_write because local coding agents may edit files',
    };
  }

  const workspace = await requireBoundWorkspace(context);
  if (!workspace.ok) return workspace;
  const root = workspace.path;
  const cwdTarget = resolveWorkspacePath(root, typeof args.cwd === 'string' ? args.cwd : '.');
  if (!cwdTarget.ok) return cwdTarget;
  const timeoutMs = clampInteger(args.timeoutMs, 120000, 10000, 600000);
  const before = await snapshotWorkspace(root);
  const commandSpec = buildLocalAgentCommand(provider, task, {
    cwd: cwdTarget.path,
    model: typeof args.model === 'string' ? args.model.trim() : '',
  });
  if (!commandSpec.ok) return commandSpec;

  const result = await runProcess(commandSpec.command, commandSpec.args, {
    cwd: cwdTarget.path,
    timeoutMs,
  });
  const after = await snapshotWorkspace(root);
  const files = diffWorkspaceSnapshots(before, after);

  return {
    ok: result.exitCode === 0 && !result.timedOut,
    provider,
    command: [commandSpec.command, ...commandSpec.args].join(' '),
    commandName: commandSpec.command,
    commandArgs: commandSpec.args,
    cwd: cwdTarget.relativePath || '.',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    files,
  };
}

function buildLocalAgentCommand(provider, task, options) {
  const modelArgs = options.model ? ['--model', options.model] : [];
  if (provider === 'codex') {
    return {
      ok: true,
      command: 'codex',
      args: [
        'exec',
        '-C',
        options.cwd,
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--ephemeral',
        ...modelArgs,
        task,
      ],
    };
  }
  if (provider === 'claude') {
    return {
      ok: true,
      command: 'claude',
      args: [
        '--print',
        '--permission-mode',
        'acceptEdits',
        ...(options.model ? ['--model', options.model] : []),
        task,
      ],
    };
  }
  if (provider === 'opencode') {
    return {
      ok: true,
      command: 'opencode',
      args: [
        'run',
        '--dangerously-skip-permissions',
        '--dir',
        options.cwd,
        ...(options.model ? ['--model', options.model] : []),
        task,
      ],
    };
  }
  return { ok: false, error: `Unsupported local agent provider: ${provider}` };
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise) => {
    const startTime = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: '1',
        GIT_CEILING_DIRECTORIES: dirname(options.cwd),
        NO_COLOR: '1',
        npm_config_update_notifier: 'false',
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const maxOutput = 40000;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk.toString(), maxOutput);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), maxOutput);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: 1,
        signal: null,
        timedOut,
        stdout,
        stderr: appendLimited(stderr, err.message, maxOutput),
        durationMs: Date.now() - startTime,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

async function snapshotWorkspace(root) {
  const files = new Map();
  await collectWorkspaceFiles(root, '.', files);
  return files;
}

async function collectWorkspaceFiles(root, dir, files) {
  if (files.size >= 500) return;
  const absoluteDir = resolve(root, dir);
  let entries = [];
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const relativePath = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    const absolutePath = resolve(root, relativePath);
    if (entry.isDirectory()) {
      await collectWorkspaceFiles(root, relativePath, files);
    } else if (entry.isFile()) {
      try {
        const info = await stat(absolutePath);
        files.set(relativePath, {
          path: relativePath,
          bytes: info.size,
          mtimeMs: Math.round(info.mtimeMs),
        });
      } catch {
        // Ignore files that disappear during scanning.
      }
    }
  }
}

function diffWorkspaceSnapshots(before, after) {
  const files = [];
  for (const [path, info] of after.entries()) {
    const prev = before.get(path);
    if (!prev) {
      files.push({ path, sandboxPath: path, targetPath: path, status: 'create', bytes: info.bytes });
    } else if (prev.bytes !== info.bytes || prev.mtimeMs !== info.mtimeMs) {
      files.push({ path, sandboxPath: path, targetPath: path, status: 'modify', bytes: info.bytes });
    }
  }
  return files.slice(0, 200);
}

function looksMutatingShellCommand(command) {
  const normalized = command.toLowerCase();
  const mutatingPatterns = [
    /(^|[\s;&|])>/,
    /(^|[\s;&|])>>/,
    /(^|[\s;&|])tee\s+/,
    /(^|[\s;&|])touch\s+/,
    /(^|[\s;&|])mkdir\s+/,
    /(^|[\s;&|])rm\s+/,
    /(^|[\s;&|])mv\s+/,
    /(^|[\s;&|])cp\s+/,
    /(^|[\s;&|])sed\s+-i\b/,
    /(^|[\s;&|])perl\s+-i\b/,
    /(^|[\s;&|])npm\s+(install|i|add|remove|uninstall)\b/,
    /(^|[\s;&|])pnpm\s+(add|remove|install|i)\b/,
    /(^|[\s;&|])yarn\s+(add|remove|install)\b/,
  ];
  return mutatingPatterns.some((pattern) => pattern.test(normalized));
}

async function ensureWorkspace(context) {
  if (context.workspacePath) {
    const workspace = resolve(context.workspacePath);
    await mkdir(workspace, { recursive: true });
    return workspace;
  }
  const root = resolve(context.workspaceRoot || new URL('../workspaces/', import.meta.url).pathname);
  const runID = sanitizeSegment(context.workspaceID || context.runID || context.event?.serverMsgID || 'default');
  const workspace = resolve(root, runID);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function requireBoundWorkspace(context) {
  if (!context.workspacePath) {
    return {
      ok: false,
      error: '请先为当前会话选择工作区，然后再让 Agent 读取、写入或运行代码。',
      code: 'WORKSPACE_REQUIRED',
    };
  }
  const workspace = resolve(context.workspacePath);
  await mkdir(workspace, { recursive: true });
  return { ok: true, path: workspace };
}

function resolveWorkspacePath(root, inputPath) {
  const rawPath = typeof inputPath === 'string' && inputPath.trim() ? inputPath.trim() : '.';
  const resolvedPath = resolve(root, rawPath);
  const relativePath = relative(root, resolvedPath);
  if (relativePath.startsWith('..') || relativePath === '..' || resolvedPath !== root && relativePath === '') {
    return { ok: false, error: 'Path escapes the agent workspace' };
  }
  return {
    ok: true,
    path: resolvedPath,
    relativePath: relativePath || '.',
  };
}

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'default';
}

function appendLimited(current, next, max) {
  const combined = current + next;
  if (combined.length <= max) return combined;
  return combined.slice(0, max) + '\n...[truncated]';
}

function clampInteger(value, defaultValue, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}
