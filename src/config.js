import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadConfig() {
  const yamlData = readYamlConfig(join(__dirname, '..', 'config.yaml'));
  const resolve = (envKey, yamlKey, defaultValue) =>
    resolveConfigValue(envKey, yamlKey, yamlData, defaultValue);

  return {
    port: resolve('CHATBOT_HOST_PORT', 'port', 3100),
    imServerBaseURL: resolve('IM_SERVER_BASE_URL', 'imServerBaseURL', 'http://localhost:3000'),
    imServerWSURL: resolve('IM_SERVER_WS_URL', 'imServerWSURL', 'ws://localhost:3000'),
    storageDir: resolve('CHATBOT_HOST_STORAGE_DIR', 'storageDir', join(__dirname, '..', 'data')),
    workspaceRoot: resolve('CHATBOT_HOST_WORKSPACE_ROOT', 'workspaceRoot', join(__dirname, '..', 'workspaces')),
    workspaceMode: resolve('CHATBOT_HOST_WORKSPACE_MODE', 'workspaceMode', 'auto'),
    repoRoot: resolve('CHATBOT_HOST_REPO_ROOT', 'repoRoot', join(__dirname, '..')),
  };
}

export function resolveConfigValue(envKey, yamlKey, yamlData, defaultValue) {
  if (envKey && process.env[envKey] !== undefined && process.env[envKey] !== '') {
    const value = process.env[envKey];
    if (envKey === 'CHATBOT_HOST_PORT') return parseInt(value, 10);
    return value;
  }

  if (yamlData != null && typeof yamlData === 'object' && yamlKey in yamlData) {
    return yamlData[yamlKey];
  }

  return defaultValue;
}

function readYamlConfig(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    return loadYaml(raw) || {};
  } catch {
    return {};
  }
}
