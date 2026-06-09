import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadConfig() {
  const arkFromFile = loadArkTokenFile();
  return {
    port: parseInt(process.env.CHATBOT_HOST_PORT || '3100', 10),
    imServerBaseURL: process.env.IM_SERVER_BASE_URL || 'http://localhost:3000',
    storageDir: process.env.CHATBOT_HOST_STORAGE_DIR || join(__dirname, '..', 'data'),
    workspaceRoot: process.env.CHATBOT_HOST_WORKSPACE_ROOT || join(__dirname, '..', 'workspaces'),
    repoRoot: process.env.CHATBOT_HOST_REPO_ROOT || join(__dirname, '..'),
    ark: {
      baseURL: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: process.env.ARK_API_KEY || arkFromFile.apiKey,
      model: process.env.ARK_MODEL || arkFromFile.model,
    },
  };
}

function loadArkTokenFile() {
  const tokenFile = process.env.CHATBOT_HOST_TOKEN_FILE || join(__dirname, '..', 'token');
  try {
    const raw = readFileSync(tokenFile, 'utf8');
    const apiKey = raw.split(/\r?\n/).find((line) => line.trim().startsWith('ark-'))?.trim() || '';
    const model = raw.match(/EP[:：]\s*([^\s]+)/)?.[1] || '';
    return { apiKey, model };
  } catch {
    return { apiKey: '', model: '' };
  }
}
