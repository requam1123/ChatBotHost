export async function seedData(store, imClient, log, createCredential) {
  let changed = false;
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
        systemPrompt: 'You are a planning agent. Break user goals into clear, verifiable steps. In group chats, use list_group_agents and send_agent_task to assign work to specialist agents; after agent_result messages arrive, use query_agent_task_results and send_agent_summary to report back.',
        enabledToolIDs: ['get_current_time', 'read_conversation_messages', 'get_group_members', 'list_group_agents', 'send_agent_task', 'query_agent_task_results', 'send_agent_summary'],
        description: 'Breaks goals into plans and coordinates follow-up work.',
        tags: ['planning', 'workflow'],
        greeting: '',
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
        enabledToolIDs: ['get_current_time', 'read_conversation_messages', 'send_agent_result', 'workspace_read', 'workspace_write', 'bash'],
        description: 'Helps with code analysis, implementation planning, and controlled edits.',
        tags: ['coding', 'review'],
        greeting: '',
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
        greeting: '',
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
        enabledToolIDs: ['get_current_time', 'read_conversation_messages', 'send_agent_result', 'workspace_read', 'bash'],
        description: 'Reviews code for correctness, edge cases, and maintainability.',
        tags: ['review', 'quality'],
        greeting: '',
        status: 'active',
        createTime: now,
        updateTime: now,
      },
    ];

    await store.writeCollection('templates', seedTemplates);
    log.info(`已创建 ${seedTemplates.length} 个 public 模板`);
    return true;
  }

  if (migrateCollaborationTools(templates)) {
    await store.writeCollection('templates', templates);
    changed = true;
    log.info('已补齐 Agent 协作协议模板工具');
  }

  const agents = await store.readCollection('agents');
  if (migrateCollaborationTools(agents)) {
    await store.writeCollection('agents', agents);
    changed = true;
    log.info('已补齐 Agent 协作协议实例工具');
  }

  return changed;
}

function migrateCollaborationTools(items) {
  let changed = false;
  for (const item of items) {
    const tools = new Set(Array.isArray(item.enabledToolIDs) ? item.enabledToolIDs : []);
    const before = tools.size;
    if (looksLikePlanner(item)) {
      for (const toolID of [
        'get_current_time',
        'read_conversation_messages',
        'get_group_members',
        'list_group_agents',
        'send_agent_task',
        'query_agent_task_results',
        'send_agent_summary',
      ]) {
        tools.add(toolID);
      }
    }
    if (looksLikeWorker(item)) {
      for (const toolID of ['read_conversation_messages', 'send_agent_result']) {
        tools.add(toolID);
      }
    }
    if (tools.size !== before || !Array.isArray(item.enabledToolIDs)) {
      item.enabledToolIDs = Array.from(tools);
      item.updateTime = Date.now();
      changed = true;
    }
  }
  return changed;
}

function looksLikePlanner(item) {
  const text = [item.templateID, item.name, item.nickname, item.description, item.systemPrompt].filter(Boolean).join(' ');
  return item.templateID === 'planner' || /planner|orchestrator|协调|规划/i.test(text);
}

function looksLikeWorker(item) {
  const text = [item.templateID, item.name, item.nickname, item.description, item.systemPrompt].filter(Boolean).join(' ');
  return item.templateID === 'coder' ||
    item.templateID === 'reviewer' ||
    /coder|reviewer|代码|审查|实现/i.test(text);
}
