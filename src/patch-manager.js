import { access, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('patch');

const protectedPathPatterns = [
  /^\.git(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /^token$/,
  /^ChatBotHost\/data(?:\/|$)/,
  /^ChatBotHost\/workspaces(?:\/|$)/,
  /(?:^|\/)\.env(?:\.|$)/,
];

export async function createPatchPreview({ config, run, body = {} }) {
  log.info(`创建 Patch 预览: runID=${run.runID || 'unknown'}`);
  const mappings = resolvePatchMappings({ config, run, body });
  const files = [];
  for (const mapping of mappings) {
    const beforeExists = await exists(mapping.repoPath);
    const beforeContent = beforeExists ? await readFile(mapping.repoPath, 'utf8') : '';
    const afterContent = await readFile(mapping.workspacePath, 'utf8');
    if (beforeExists && beforeContent === afterContent) continue;
    const diff = await createUnifiedDiff(mapping.repoPath, mapping.workspacePath, mapping.targetPath, beforeExists);
    files.push({
      sandboxPath: mapping.sandboxPath,
      targetPath: mapping.targetPath,
      status: beforeExists ? 'modify' : 'create',
      beforeBytes: Buffer.byteLength(beforeContent),
      afterBytes: Buffer.byteLength(afterContent),
      diff,
    });
  }
  if (files.length === 0) {
    log.warn('Patch 预览: 未发现文件变更');
    throw new Error('No file changes found for patch preview');
  }

  log.info(`Patch 预览完成: ${files.length} 个文件`);
  return {
    proposalID: `patch_${Date.now()}`,
    status: 'pending',
    workspaceID: run.workspaceID || run.runID,
    createTime: Date.now(),
    files,
  };
}

export async function applyPatchProposal({ config, run, proposal }) {
  if (!proposal || proposal.status !== 'pending') {
    throw new Error('Patch proposal is not pending');
  }
  log.info(`应用 Patch: proposalID=${proposal.proposalID}, files=${proposal.files?.length || 0}`);
  const appliedFiles = [];
  for (const file of proposal.files || []) {
    const mapping = resolveSingleMapping({
      config,
      run,
      sandboxPath: file.sandboxPath,
      targetPath: file.targetPath,
    });
    await mkdir(dirname(mapping.repoPath), { recursive: true });
    await copyFile(mapping.workspacePath, mapping.repoPath);
    const info = await stat(mapping.repoPath);
    appliedFiles.push({
      targetPath: mapping.targetPath,
      bytes: info.size,
      contentHash: await hashFile(mapping.repoPath),
    });
    log.info(`Patch 文件已应用: ${mapping.targetPath} (${info.size} bytes)`);
  }

  log.info(`Patch 应用完成: ${appliedFiles.length} 个文件`);
  return {
    ...proposal,
    status: 'applied',
    appliedFiles,
    appliedTime: Date.now(),
  };
}

function resolvePatchMappings({ config, run, body }) {
  const requestedFiles = Array.isArray(body.files) ? body.files : [];
  const sourceFiles = requestedFiles.length > 0
    ? requestedFiles
    : inferFilesFromRun(run);

  const unique = new Map();
  for (const file of sourceFiles) {
    const sandboxPath = typeof file.sandboxPath === 'string' ? file.sandboxPath : file.path;
    const targetPath = typeof file.targetPath === 'string' ? file.targetPath : sandboxPath;
    if (!sandboxPath || !targetPath) continue;
    const key = `${sandboxPath}=>${targetPath}`;
    if (!unique.has(key)) {
      unique.set(key, resolveSingleMapping({ config, run, sandboxPath, targetPath }));
    }
  }
  const mappings = [...unique.values()];
  if (mappings.length === 0) {
    throw new Error('No workspace_write files found for patch preview');
  }
  return mappings;
}

function inferFilesFromRun(run) {
  const files = [];
  for (const call of run.toolCalls || []) {
    if (call.toolID === 'workspace_write' && call.result?.ok && call.result?.path) {
      files.push({
        sandboxPath: call.result.path,
        targetPath: call.result.path,
      });
    }
  }
  return files;
}

function resolveSingleMapping({ config, run, sandboxPath, targetPath }) {
  const workspaceRoot = resolve(run.workspacePath || config.workspaceRoot, run.workspacePath ? '.' : (run.workspaceID || run.runID));
  const repoRoot = resolve(run.workspaceTargetPath || config.repoRoot);
  const workspacePath = resolveInside(workspaceRoot, sandboxPath, 'Sandbox path escapes workspace');
  const repoPath = resolveInside(repoRoot, targetPath, 'Target path escapes repo');
  const normalizedTarget = toPosix(relative(repoRoot, repoPath));
  if (isProtectedTarget(normalizedTarget)) {
    throw new Error(`Protected target path is not allowed: ${normalizedTarget}`);
  }
  return {
    sandboxPath: toPosix(relative(workspaceRoot, workspacePath)),
    targetPath: normalizedTarget,
    workspacePath,
    repoPath,
  };
}

function resolveInside(root, childPath, errorMessage) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, childPath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === '..' || rel.startsWith(`..${pathSeparator()}`) || rel === '') {
    if (rel === '') return resolvedPath;
    throw new Error(errorMessage);
  }
  return resolvedPath;
}

function isProtectedTarget(targetPath) {
  return protectedPathPatterns.some((pattern) => pattern.test(targetPath));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(path) {
  const content = await readFile(path);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function createUnifiedDiff(repoPath, workspacePath, targetPath, beforeExists) {
  const beforePath = beforeExists ? repoPath : '/dev/null';
  const args = ['diff', '--no-index', '--', beforePath, workspacePath];
  const result = await runCommand('git', args, resolve(repoPath, '..'));
  const raw = result.stdout || result.stderr || '';
  if (!raw.trim()) return '';
  if (!beforeExists) {
    return raw
      .replaceAll('a/dev/null', `a/${targetPath}`)
      .replaceAll(`b${workspacePath}`, `b/${targetPath}`)
      .replaceAll(workspacePath, `b/${targetPath}`)
      .replaceAll('diff --git ab/', 'diff --git a/')
      .replaceAll('diff --git aa/', 'diff --git a/');
  }
  return raw
    .replaceAll(`a${repoPath}`, `a/${targetPath}`)
    .replaceAll(`b${workspacePath}`, `b/${targetPath}`)
    .replaceAll(repoPath, `a/${targetPath}`)
    .replaceAll(workspacePath, `b/${targetPath}`)
    .replaceAll('diff --git ab/', 'diff --git a/')
    .replaceAll('diff --git aa/', 'diff --git a/');
}

function runCommand(command, args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      resolvePromise({ code: 1, stdout, stderr: err.message });
    });
  });
}

function pathSeparator() {
  return '/';
}

function toPosix(path) {
  return path.split('\\').join('/');
}
