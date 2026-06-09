import { access, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';

const excludedNames = new Set(['.git', 'node_modules', '.DS_Store']);

export async function listWorkspaces({ store, ownerUserID }) {
  const workspaces = await store.readCollection('workspaces');
  return workspaces
    .filter((workspace) => workspace.ownerUserID === ownerUserID)
    .sort((a, b) => (b.updateTime || b.createTime || 0) - (a.updateTime || a.createTime || 0));
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

  await mkdir(workspace.sandboxPath, { recursive: true });
  await seedSandboxFromTarget(workspace);

  const workspaces = await store.readCollection('workspaces');
  workspaces.push(workspace);
  await store.writeCollection('workspaces', workspaces);
  return workspace;
}

export async function ensureDefaultWorkspace({ store, config, ownerUserID }) {
  const workspaces = await listWorkspaces({ store, ownerUserID });
  if (workspaces.length > 0) return workspaces[0];

  const defaultPath = resolve(config.repoRoot, 'my-web-workspace');
  if (!(await exists(defaultPath))) return null;
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
  if (existingIndex >= 0) bindings[existingIndex] = binding;
  else bindings.push(binding);
  await store.writeCollection('conversation-workspaces', bindings);
  return { binding, workspace };
}

export async function getConversationWorkspace({ store, config, ownerUserID, conversationID, autoCreate = false }) {
  const bindings = await store.readCollection('conversation-workspaces');
  const binding = bindings.find((item) => item.ownerUserID === ownerUserID && item.conversationID === conversationID);
  if (binding) {
    const workspace = await requireWorkspace({ store, config, ownerUserID, workspaceID: binding.workspaceID });
    return { binding, workspace };
  }
  return { binding: null, workspace: null };
}

export async function requireWorkspace({ store, config, ownerUserID, workspaceID }) {
  const workspaces = await store.readCollection('workspaces');
  const workspace = workspaces.find((item) => item.workspaceID === workspaceID && item.ownerUserID === ownerUserID);
  if (!workspace) throw new HttpError(404, 'Workspace not found');
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
    return {
      workspaceID: event.conversationID || event.serverMsgID || '',
      workspacePath: '',
      targetPath: '',
      workspaceName: '',
    };
  }
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
  return { files, source, dir };
}

export async function readWorkspaceFile({ workspace, source = 'sandbox', filePath }) {
  const root = getWorkspaceSourceRoot(workspace, source);
  const absolutePath = resolveInside(root, filePath, 'Path escapes workspace');
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new HttpError(400, 'Path is not a file');
  const content = await readFile(absolutePath, 'utf8');
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
  await writeFile(absolutePath, typeof content === 'string' ? content : '', 'utf8');
  return { path: toPosix(relative(root, absolutePath)), source, bytes: Buffer.byteLength(content || '') };
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
