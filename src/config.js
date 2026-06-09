import { readFileSync } from 'node:fs';

export function loadConfig() {
  const arkFromFile = loadArkTokenFile();
  return {
    port: parseInt(process.env.CHATBOT_HOST_PORT || '3100', 10),
    imServerBaseURL: process.env.IM_SERVER_BASE_URL || 'http://localhost:3000',
    storageDir: process.env.CHATBOT_HOST_STORAGE_DIR || new URL('../data/', import.meta.url).pathname,
    workspaceRoot: process.env.CHATBOT_HOST_WORKSPACE_ROOT || new URL('../workspaces/', import.meta.url).pathname,
    repoRoot: process.env.CHATBOT_HOST_REPO_ROOT || new URL('../', import.meta.url).pathname,
    ark: {
      baseURL: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: process.env.ARK_API_KEY || arkFromFile.apiKey,
      model: process.env.ARK_MODEL || arkFromFile.model,
    },
  };
}

function loadArkTokenFile() {
  const tokenFile = process.env.CHATBOT_HOST_TOKEN_FILE || new URL('../token', import.meta.url).pathname;
  try {
    const raw = readFileSync(tokenFile, 'utf8');
    const apiKey = raw.split(/\r?\n/).find((line) => line.trim().startsWith('ark-'))?.trim() || '';
    const model = raw.match(/EP[:：]\s*([^\s]+)/)?.[1] || '';
    return { apiKey, model };
  } catch {
    return { apiKey: '', model: '' };
  }
}
