import { randomUUID } from 'node:crypto';

export async function listVisibleTemplates(store, ownerUserID) {
  const templates = await store.readCollection('templates');
  return templates.filter(
    (t) => t.ownerUserID === 'public' || t.ownerUserID === ownerUserID,
  );
}

export async function getTemplate(store, templateID) {
  const templates = await store.readCollection('templates');
  return templates.find((t) => t.templateID === templateID);
}

export async function createTemplate(store, { ownerUserID, name, avatarURL, systemPrompt, enabledToolIDs, description, tags }) {
  const templates = await store.readCollection('templates');
  const now = Date.now();
  const template = {
    templateID: `tmpl_${randomUUID()}`,
    ownerUserID,
    name: name || '',
    avatarURL: avatarURL || '',
    systemPrompt: systemPrompt || '',
    enabledToolIDs: Array.isArray(enabledToolIDs) ? enabledToolIDs : [],
    description: description || '',
    tags: Array.isArray(tags) ? tags : [],
    status: 'active',
    createTime: now,
    updateTime: now,
  };
  templates.push(template);
  await store.writeCollection('templates', templates);
  return { template };
}

export async function updateTemplate(store, templateID, ownerUserID, updates) {
  const templates = await store.readCollection('templates');
  const index = templates.findIndex((t) => t.templateID === templateID);
  if (index === -1) return null;

  const current = templates[index];
  if (current.ownerUserID !== ownerUserID) {
    if (current.ownerUserID === 'public') return null;
    return null;
  }

  const allowedKeys = ['name', 'avatarURL', 'systemPrompt', 'enabledToolIDs', 'description', 'tags', 'status'];
  for (const key of allowedKeys) {
    if (updates[key] !== undefined) {
      if (key === 'enabledToolIDs' || key === 'tags') {
        templates[index][key] = Array.isArray(updates[key]) ? updates[key] : current[key];
      } else {
        templates[index][key] = updates[key];
      }
    }
  }
  templates[index].updateTime = Date.now();
  await store.writeCollection('templates', templates);
  return { template: templates[index] };
}

export async function deleteTemplate(store, templateID, ownerUserID) {
  const templates = await store.readCollection('templates');
  const index = templates.findIndex((t) => t.templateID === templateID);
  if (index === -1) return null;

  if (templates[index].ownerUserID !== ownerUserID) {
    if (templates[index].ownerUserID === 'public') return null;
    return null;
  }

  const deleted = templates.splice(index, 1)[0];
  await store.writeCollection('templates', templates);
  return { template: deleted };
}
