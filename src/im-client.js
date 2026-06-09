import { HttpError } from './http.js';
import { createLogger } from './logger.js';

const log = createLogger('im');

export class ImClient {
  constructor(baseURL) {
    this.baseURL = baseURL.replace(/\/$/, '');
    log.info(`IM client initialized, baseURL: ${this.baseURL}`);
  }

  async getToken(userID, platformID = 5) {
    log.info(`获取 token: userID=${userID}`);
    const data = await this.post('/auth/get_user_token', { userID, platformID });
    return data.token;
  }

  async registerAgentUser({ userID, nickname, faceURL, agentPrompt }) {
    log.info(`注册 Agent: userID=${userID}, nickname=${nickname}`);
    await this.post('/user/user_register', {
      users: [{
        userID,
        nickname,
        faceURL,
        isAgent: true,
        agentPrompt,
      }],
    });
  }

  async ensureFriendPair(ownerUserID, agentUserID) {
    log.info(`建立好友关系: ${ownerUserID} <-> ${agentUserID}`);
    const ownerToken = await this.getToken(ownerUserID);
    const agentToken = await this.getToken(agentUserID);

    const addResult = await this.post('/friend/add_friend', {
      fromUserID: ownerUserID,
      toUserID: agentUserID,
      reqMsg: 'Added from model marketplace',
    }, ownerToken, { tolerateStatuses: [409] });

    if (addResult?._status === 409) {
      log.info(`好友关系已存在: ${ownerUserID} <-> ${agentUserID}`);
      return;
    }

    await this.post('/friend/respond_friend_apply', {
      fromUserID: ownerUserID,
      toUserID: agentUserID,
      handleResult: 1,
      handleMsg: 'Auto-accepted by ChatBotHost',
    }, agentToken, { tolerateStatuses: [404, 409] });
    log.info(`好友关系建立完成: ${ownerUserID} <-> ${agentUserID}`);
  }

  async getGroupMembers(groupID, requesterUserID) {
    log.info(`获取群成员: groupID=${groupID}`);
    const token = await this.getToken(requesterUserID);
    const data = await this.post('/group/get_group_members', { groupID }, token);
    const count = Array.isArray(data.members) ? data.members.length : 0;
    log.info(`群成员数量: ${count}`);
    return Array.isArray(data.members) ? data.members : [];
  }

  async sendMessage({ sendID, recvID, groupID, content, senderNickname, senderFaceURL, atUserIDList = [], contentType }) {
    const contentPreview = truncateText(content, 100);
    const target = groupID ? `group(${groupID})` : recvID;
    log.info(`发送消息: from=${sendID}, to=${target}, content="${contentPreview}"`);
    const token = await this.getToken(sendID);
    const result = await this.post('/msg/send_msg', {
      sendID,
      recvID,
      groupID,
      sessionType: groupID ? 2 : 1,
      contentType: contentType || (atUserIDList.length > 0 ? 106 : 101),
      content,
      atUserIDList,
      senderPlatformID: 12,
      senderNickname,
      senderFaceURL,
    }, token);
    if (result.serverMsgID) {
      log.info(`消息发送成功: serverMsgID=${result.serverMsgID}`);
    }
    return result;
  }

  async patchMessage(serverMsgId, contentPatch, isFinished = false) {
    const preview = truncateText(contentPatch, 60);
    log.info(`更新消息: serverMsgID=${serverMsgId}, finished=${isFinished}, content="${preview}"`);
    return this.request('PATCH', '/msg/patch_update', {
      serverMsgId,
      contentPatch,
      isFinished,
    });
  }

  async post(path, body, token, options = {}) {
    return this.request('POST', path, body, token, options);
  }

  async request(method, path, body, token, options = {}) {
    const res = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const payload = await safeJson(res);
    const tolerateStatuses = new Set(options.tolerateStatuses || []);

    if (!res.ok || payload.errCode) {
      if (tolerateStatuses.has(res.status)) return { ...payload.data, _status: res.status };
      const errMsg = payload.errMsg || `IM request failed: ${path}`;
      log.error(`IM API 请求失败: ${method} ${path} -> ${res.status}, ${errMsg}`);
      throw new HttpError(res.status || payload.errCode || 502, errMsg);
    }

    return payload.data || {};
  }
}

function truncateText(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  return `${text.slice(0, maxLen)}... (${text.length} chars)`;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return { errCode: res.status, errMsg: await res.text() };
  }
}
