import { HttpError } from './http.js';

export class ImClient {
  constructor(baseURL) {
    this.baseURL = baseURL.replace(/\/$/, '');
  }

  async getToken(userID, platformID = 5) {
    const data = await this.post('/auth/get_user_token', { userID, platformID });
    return data.token;
  }

  async registerAgentUser({ userID, nickname, faceURL, agentPrompt }) {
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
    const ownerToken = await this.getToken(ownerUserID);
    const agentToken = await this.getToken(agentUserID);

    const addResult = await this.post('/friend/add_friend', {
      fromUserID: ownerUserID,
      toUserID: agentUserID,
      reqMsg: 'Added from model marketplace',
    }, ownerToken, { tolerateStatuses: [409] });

    if (addResult?._status === 409) return;

    await this.post('/friend/respond_friend_apply', {
      fromUserID: ownerUserID,
      toUserID: agentUserID,
      handleResult: 1,
      handleMsg: 'Auto-accepted by ChatBotHost',
    }, agentToken, { tolerateStatuses: [404, 409] });
  }

  async sendMessage({ sendID, recvID, content, senderNickname, senderFaceURL }) {
    const token = await this.getToken(sendID);
    return this.post('/msg/send_msg', {
      sendID,
      recvID,
      sessionType: 1,
      contentType: 101,
      content,
      senderPlatformID: 12,
      senderNickname,
      senderFaceURL,
    }, token);
  }

  async patchMessage(serverMsgId, contentPatch, isFinished = false) {
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
      throw new HttpError(res.status || payload.errCode || 502, payload.errMsg || `IM request failed: ${path}`);
    }

    return payload.data || {};
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return { errCode: res.status, errMsg: await res.text() };
  }
}
