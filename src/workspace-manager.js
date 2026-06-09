import { access, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import { createLogger } from './logger.js';

const log = createLogger('workspace');

const excludedNames = new Set(['.git', 'node_modules', '.DS_Store']);

export async function listWorkspaces({ store, ownerUserID }) {
  const workspaces = await store.readCollection('workspaces');
  const filtered = workspaces
    .filter((workspace) => workspace.ownerUserID === ownerUserID)
    .sort((a, b) => (b.updateTime || b.createTime || 0) - (a.updateTime || a.createTime || 0));
  log.info(`列出工作区: user=${ownerUserID}, count=${filtered.length}`);
  return filtered;
}

export async function createWorkspace({ store, config, ownerUserID, name, targetPath }) {
  const resolvedTargetPath = await validateWorkspacePath(targetPath);
  const now = Date.now();
  const workspace = {
    workspaceID: `ws_${randomUUID()}`,
    ownerUserID,
    name: name?.trim() || basename(resolvedTargetPath),
    targetPath: resolvedTargetPath,
    sandboxPath: resolve(config.workspaceRoot, `ws_${randomUUID()}`),
    status: 'active',
    createTime: now,
    updateTime: now,
  };

  log.info(`创建工作区: id=${workspace.workspaceID}, name=${workspace.name}, target=${workspace.targetPath}`);
  log.info(`sandbox 路径: ${workspace.sandboxPath}`);

  await mkdir(workspace.sandboxPath, { recursive: true });
  log.info(`从 target 目录 seed sandbox: ${workspace.targetPath} -> ${workspace.sandboxPath}`);
  await seedSandboxFromTarget(workspace);

  const workspaces = await store.readCollection('workspaces');
  workspaces.push(workspace);
  await store.writeCollection('workspaces', workspaces);
  log.info(`工作区创建完成: ${workspace.workspaceID}, 总工作区数: ${workspaces.length}`);
  return workspace;
}

export async function ensureDefaultWorkspace({ store, config, ownerUserID }) {
  const workspaces = await listWorkspaces({ store, ownerUserID });
  if (workspaces.length > 0) return workspaces[0];

  log.info(`用户 ${ownerUserID} 无工作区，尝试创建默认工作区`);
  const defaultPath = resolve(config.repoRoot, 'my-web-workspace');
  if (!(await exists(defaultPath))) {
    log.info(`默认工作区路径不存在: ${defaultPath}`);
    return null;
  }
  return createWorkspace({
    store,
    config,
    ownerUserID,
    name: 'my-web-workspace',
    targetPath: defaultPath,
  });
}

export async function bindConversationWorkspace({ store, config, ownerUserID, conversationID, workspaceID }) {
  const workspace = await requireWorkspace({ store, config, ownerUserID, workspaceID });
  const bindings = await store.readCollection('conversation-workspaces');
  const now = Date.now();
  const existingIndex = bindings.findIndex((binding) =>
    binding.ownerUserID === ownerUserID && binding.conversationID === conversationID
  );
  const binding = {
    ownerUserID,
    conversationID,
    workspaceID: workspace.workspaceID,
    createTime: existingIndex >= 0 ? bindings[existingIndex].createTime : now,
    updateTime: now,
  };
  if (existingIndex >= 0) {
    bindings[existingIndex] = binding;
    log.info(`更新会话-工作区绑定: conversation=${conversationID} -> workspace=${workspaceID}`);
  } else {
    bindings.push(binding);
    log.info(`新建会话-工作区绑定: conversation=${conversationID} -> workspace=${workspaceID}`);
  }
  await store.writeCollection('conversation-workspaces', bindings);
  return { binding, workspace };
}

export async function getConversationWorkspace({ store, config, ownerUserID, conversationID, autoCreate = false }) {
  const bindings = await store.readCollection('conversation-workspaces');
  const binding = bindings.find((item) => item.ownerUserID === ownerUserID && item.conversationID === conversationID);
  if (binding) {
    const workspace = await requireWorkspace({ store, config, ownerUserID, workspaceID: binding.workspaceID });
    log.info(`查询会话工作区: conversation=${conversationID} -> workspace=${workspace.workspaceID}`);
    return { binding, workspace };
  }
  log.info(`会话无工作区绑定: conversation=${conversationID}`);
  return { binding: null, workspace: null };
}

export async function requireWorkspace({ store, config, ownerUserID, workspaceID }) {
  const workspaces = await store.readCollection('workspaces');
  const workspace = workspaces.find((item) => item.workspaceID === workspaceID && item.ownerUserID === ownerUserID);
  if (!workspace) {
    log.warn(`工作区不存在: workspaceID=${workspaceID}, ownerUserID=${ownerUserID}`);
    throw new HttpError(404, 'Workspace not found');
  }
  workspace.sandboxPath ||= resolve(config.workspaceRoot, workspace.workspaceID);
  await mkdir(workspace.sandboxPath, { recursive: true });
  return workspace;
}

export async function resolveEventWorkspace({ store, config, event, ownerUserID }) {
  const { workspace } = await getConversationWorkspace({
    store,
    config,
    ownerUserID,
    conversationID: event.conversationID,
    autoCreate: false,
  });
  if (!workspace) {
    log.info(`事件无工作区: conversation=${event.conversationID}`);
    return {
      workspaceID: event.conversationID || event.serverMsgID || '',
      workspacePath: '',
      targetPath: '',
      workspaceName: '',
    };
  }
  log.info(`解析事件工作区: conversation=${event.conversationID} -> workspace=${workspace.workspaceID}, sandbox=${workspace.sandboxPath}`);
  return {
    workspaceID: workspace.workspaceID,
    workspacePath: workspace.sandboxPath,
    targetPath: workspace.targetPath,
    workspaceName: workspace.name,
  };
}

export async function listWorkspaceFiles({ workspace, source = 'sandbox', dir = '' }) {
  const root = getWorkspaceSourceRoot(workspace, source);
  const absoluteDir = resolveInside(root, dir, 'Path escapes workspace');
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => !excludedNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: toPosix(relative(root, resolve(absoluteDir, entry.name))),
      type: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  log.info(`列出工作区文件: source=${source}, dir="${dir}", entries=${files.length}`);
  return { files, source, dir };
}

export async function readWorkspaceFile({ workspace, source = 'sandbox', filePath }) {
  const root = getWorkspaceSourceRoot(workspace, source);
  const absolutePath = resolveInside(root, filePath, 'Path escapes workspace');
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new HttpError(400, 'Path is not a file');
  const content = await readFile(absolutePath, 'utf8');
  log.info(`读取工作区文件: source=${source}, path=${filePath}, bytes=${Buffer.byteLength(content)}`);
  return {
    path: toPosix(relative(root, absolutePath)),
    content,
    bytes: Buffer.byteLength(content),
    source,
  };
}

export async function writeWorkspaceFile({ workspace, source = 'sandbox', filePath, content }) {
  if (source !== 'sandbox') throw new HttpError(400, 'Only sandbox workspace files can be edited here');
  const root = getWorkspaceSourceRoot(workspace, source);
  const absolutePath = resolveInside(root, filePath, 'Path escapes workspace');
  await mkdir(dirname(absolutePath), { recursive: true });
  const bytes = Buffer.byteLength(typeof content === 'string' ? content : '');
  await writeFile(absolutePath, typeof content === 'string' ? content : '', 'utf8');
  log.info(`写入工作区文件: path=${filePath}, bytes=${bytes}`);
  return { path: toPosix(relative(root, absolutePath)), source, bytes };
}

function getWorkspaceSourceRoot(workspace, source) {
  if (source === 'target') return workspace.targetPath;
  return workspace.sandboxPath;
}

async function validateWorkspacePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') throw new HttpError(400, 'targetPath is required');
  const resolvedPath = resolve(inputPath);
  const info = await stat(resolvedPath);
  if (!info.isDirectory()) throw new HttpError(400, 'Workspace targetPath must be a directory');
  return resolvedPath;
}

async function seedSandboxFromTarget(workspace) {
  await mkdir(workspace.sandboxPath, { recursive: true });
  await cp(workspace.targetPath, workspace.sandboxPath, {
    recursive: true,
    force: true,
    filter: (source) => !source.split('/').some((part) => excludedNames.has(part)),
  });
}

function resolveInside(root, childPath, errorMessage) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, childPath || '');
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === '..' || rel.startsWith('../')) throw new HttpError(400, errorMessage);
  return resolvedPath;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toPosix(path) {
  return path.split('\\').join('/');
}
