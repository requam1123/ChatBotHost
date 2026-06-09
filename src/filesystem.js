import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { HttpError } from './http.js';

export async function listLocalDirectories({ config, requestedPath }) {
  const roots = buildDirectoryRoots(config);
  const currentPath = requestedPath.trim()
    ? resolveLocalDirectoryPath(requestedPath)
    : roots[0]?.path;

  if (!currentPath) {
    return { currentPath: '', parentPath: '', roots, directories: [] };
  }

  const info = await stat(currentPath).catch(() => null);
  if (!info?.isDirectory()) {
    throw new HttpError(400, 'path must be an existing directory');
  }

  const entries = await readdir(currentPath, { withFileTypes: true }).catch((err) => {
    throw new HttpError(403, err instanceof Error ? err.message : 'Cannot read directory');
  });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !shouldHideDirectory(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: resolve(currentPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = dirname(currentPath);
  return {
    currentPath,
    parentPath: parentPath === currentPath ? '' : parentPath,
    roots,
    directories,
  };
}

export function buildDirectoryRoots(config) {
  const candidates = [
    { name: '项目根目录', path: config.repoRoot },
    { name: '工作区目录', path: config.workspaceRoot },
    { name: '用户目录', path: homedir() },
    { name: '上级目录', path: dirname(config.repoRoot) },
    { name: '根目录', path: '/' },
  ];
  const seen = new Set();
  return candidates
    .map((item) => ({ name: item.name, path: resolve(item.path) }))
    .filter((item) => {
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
}

export function resolveLocalDirectoryPath(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(homedir(), trimmed);
}

export function shouldHideDirectory(name) {
  return ['.git', '.svn', '.hg', 'node_modules', '.nuxt', '.output', 'dist', 'build'].includes(name);
}
