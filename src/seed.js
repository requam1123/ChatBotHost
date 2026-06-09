export async function seedData(store, imClient, log, createCredential) {
  const credentials = await store.readCollection('credentials');
  let credentialMigrated = false;
  for (const cred of credentials) {
    if (cred.ownerUserID === 'anonymous') {
      cred.ownerUserID = 'public';
      credentialMigrated = true;
    }
  }
  if (credentialMigrated) {
    await store.writeCollection('credentials', credentials);
    log.info('已将 credential owner 从 anonymous 迁移为 public');
  }

  const templates = await store.readCollection('templates');
  if (templates.length === 0) {
    const now = Date.now();
    const seedTemplates = [
      {
        templateID: 'planner',
        ownerUserID: 'public',
        name: 'Planner Agent',
        avatarURL: 'https://api.dicebear.com/7.x/bottts/svg?seed=planner',
        systemPrompt: 'You are a planning agent. Break user goals into clear, verifiable steps.',
        enabledToolIDs: ['get_current_time', 'read_conversation_messages'],
        description: 'Breaks goals into plans and coordinates follow-up work.',
        tags: ['planning', 'workflow'],
        status: 'active',
        createTime: now,
        updateTime: now,
      },
      {
        templateID: 'coder',
        ownerUserID: 'public',
        name: 'Coder Agent',
        avatarURL: 'https://api.dicebear.com/7.x/bottts/svg?seed=coder',
        systemPrompt: 'You are a coding agent. Prefer small, tested changes and explain tradeoffs clearly.',
        enabledToolIDs: ['get_current_time', 'read_conversation_messages', 'workspace_read', 'workspace_write', 'bash'],
        description: 'Helps with code analysis, implementation planning, and controlled edits.',
        tags: ['coding', 'review'],
        status: 'active',
        createTime: now,
        updateTime: now,
      },
      {
        templateID: 'chatgpt',
        ownerUserID: 'public',
        name: 'ChatGPT',
        avatarURL: 'https://api.dicebear.com/7.x/bottts/svg?seed=chatgpt',
        systemPrompt: 'You are a helpful assistant. Be concise and accurate.',
        enabledToolIDs: ['get_current_time'],
        description: 'General-purpose conversational assistant.',
        tags: ['general'],
        status: 'active',
        createTime: now,
        updateTime: now,
      },
      {
        templateID: 'reviewer',
        ownerUserID: 'public',
        name: 'Reviewer Agent',
        avatarURL: 'https://api.dicebear.com/7.x/bottts/svg?seed=reviewer',
        systemPrompt: 'You are a code review agent. Review implementation quality, edge cases, maintainability, and risks. Return concise actionable feedback.',
        enabledToolIDs: ['get_current_time', 'read_conversation_messages', 'workspace_read', 'bash'],
        description: 'Reviews code for correctness, edge cases, and maintainability.',
        tags: ['review', 'quality'],
        status: 'active',
        createTime: now,
        updateTime: now,
      },
    ];

    await store.writeCollection('templates', seedTemplates);
    log.info(`已创建 ${seedTemplates.length} 个 public 模板`);
    return true;
  }

  return false;
}
