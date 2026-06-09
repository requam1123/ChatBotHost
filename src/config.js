import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadConfig() {
  return {
    port: parseInt(process.env.CHATBOT_HOST_PORT || '3100', 10),
    imServerBaseURL: process.env.IM_SERVER_BASE_URL || 'http://localhost:3000',
    imServerWSURL: process.env.IM_SERVER_WS_URL || 'ws://localhost:3000',
    storageDir: process.env.CHATBOT_HOST_STORAGE_DIR || join(__dirname, '..', 'data'),
    workspaceRoot: process.env.CHATBOT_HOST_WORKSPACE_ROOT || join(__dirname, '..', 'workspaces'),
    repoRoot: process.env.CHATBOT_HOST_REPO_ROOT || join(__dirname, '..'),
  };
}
