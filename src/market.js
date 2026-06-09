export const agentTemplates = [
  {
    templateID: 'planner',
    name: 'Planner Agent',
    avatarURL: 'https://api.dicebear.com/7.x/bottts/svg?seed=planner',
    defaultSystemPrompt: 'You are a planning agent. Break user goals into clear, verifiable steps.',
    defaultToolIDs: ['get_current_time', 'read_conversation_messages'],
    defaultRuntime: 'langchain-agent',
    defaultWorkerTemplateID: 'coder',
    description: 'Breaks goals into plans and coordinates follow-up work.',
    tags: ['planning', 'workflow'],
    status: 'active',
  },
  {
    templateID: 'coder',
    name: 'Coder Agent',
    avatarURL: 'https://api.dicebear.com/7.x/bottts/svg?seed=coder',
    defaultSystemPrompt: 'You are a coding agent. Prefer small, tested changes and explain tradeoffs clearly.',
    defaultToolIDs: ['get_current_time', 'read_conversation_messages', 'workspace_read', 'workspace_write', 'bash'],
    defaultRuntime: 'langchain-agent',
    defaultWorkerTemplateID: '',
    description: 'Helps with code analysis, implementation planning, and controlled edits.',
    tags: ['coding', 'review'],
    status: 'active',
  },
  {
    templateID: 'chatgpt',
    name: 'ChatGPT',
    avatarURL: 'https://api.dicebear.com/7.x/bottts/svg?seed=chatgpt',
    defaultSystemPrompt: 'You are a helpful assistant. Be concise and accurate.',
    defaultToolIDs: ['get_current_time'],
    defaultRuntime: 'langchain-agent',
    defaultWorkerTemplateID: '',
    description: 'General-purpose conversational assistant.',
    tags: ['general'],
    status: 'active',
  },
  {
    templateID: 'reviewer',
    name: 'Reviewer Agent',
    avatarURL: 'https://api.dicebear.com/7.x/bottts/svg?seed=reviewer',
    defaultSystemPrompt: 'You are a code review agent. Review implementation quality, edge cases, maintainability, and risks. Return concise actionable feedback.',
    defaultToolIDs: ['get_current_time', 'read_conversation_messages', 'workspace_read', 'bash'],
    defaultRuntime: 'langchain-agent',
    defaultWorkerTemplateID: '',
    description: 'Reviews code for correctness, edge cases, and maintainability.',
    tags: ['review', 'quality'],
    status: 'active',
  },
];

export function listActiveTemplates() {
  return agentTemplates.filter((template) => template.status === 'active');
}

export function getTemplate(templateID) {
  return listActiveTemplates().find((template) => template.templateID === templateID);
}
