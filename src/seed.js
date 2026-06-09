import { randomUUID } from 'node:crypto';
import { listActiveTemplates } from './market.js';

export async function seedData(store, imClient, log, createCredential) {
  const credentials = await store.readCollection('credentials');
  let anonymousCredentialID = credentials.find((cred) => cred.ownerUserID === 'anonymous')?.credentialID || '';

  if (!anonymousCredentialID) {
    const apiKey = process.env.ARK_API_KEY || '';
    const baseUrl = process.env.ARK_BASE_URL || 'https://api.openai.com/v1';
    if (apiKey) {
      const result = await createCredential({
        ownerUserID: 'anonymous',
        apiKey,
        baseUrl,
        name: '',
        modelName: '',
        provider: 'openai',
      });
      anonymousCredentialID = result.credential.credentialID;
      log.info(`已从环境变量迁移 anonymous credential: ${anonymousCredentialID}`);
    } else {
      const result = await createCredential({
        ownerUserID: 'anonymous',
        apiKey: 'sk-please-replace-me',
        baseUrl,
        name: '',
        modelName: '',
        provider: 'openai',
      });
      anonymousCredentialID = result.credential.credentialID;
      log.warn(`已创建占位 anonymous credential: ${anonymousCredentialID}，请通过 API 更新为真实 API Key`);
    }
  }

  const agents = await store.readCollection('agents');
  const anonymousAgents = agents.filter((agent) => agent.ownerUserID === 'anonymous');
  if (anonymousAgents.length === 0 && anonymousCredentialID) {
    for (const template of listActiveTemplates()) {
      const userAgentID = `ua_${randomUUID()}`;
      const imAgentUserID = `agent_${template.templateID}_anonymous`;
      const agent = {
        userAgentID,
        ownerUserID: 'anonymous',
        templateID: template.templateID,
        imAgentUserID,
        nickname: template.name,
        avatarURL: template.avatarURL,
        credentialID: anonymousCredentialID,
        systemPrompt: template.defaultSystemPrompt,
        enabledToolIDs: template.defaultToolIDs,
        enabledMcpConnectionIDs: [],
        runtime: template.defaultRuntime,
        workerTemplateID: template.defaultWorkerTemplateID,
        workerAgentUserID: '',
        status: 'active',
        createTime: Date.now(),
        updateTime: Date.now(),
      };

      await imClient.registerAgentUser({
        userID: imAgentUserID,
        nickname: agent.nickname,
        faceURL: agent.avatarURL,
        agentPrompt: agent.systemPrompt,
      }).catch((err) => {
        log.warn(`注册 anonymous Agent 失败: ${imAgentUserID}, ${err.message}`);
      });

      agents.push(agent);
    }
    await store.writeCollection('agents', agents);
    log.info(`已为 anonymous 创建 ${agents.length} 个 Agent`);
  }

  return anonymousAgents.length === 0 && anonymousCredentialID;
}
