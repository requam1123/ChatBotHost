import WebSocket from 'ws';
import { createLogger } from './logger.js';

const log = createLogger('ws');

export class ImWsClient {
  constructor({ wsURL, agentUserID, token, platformID = 12, onMessage, onPatch }) {
    this.wsURL = wsURL;
    this.agentUserID = agentUserID;
    this.token = token;
    this.platformID = platformID;
    this.onMessage = onMessage;
    this.onPatch = onPatch;
    this.ws = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.stopped = false;
  }

  connect() {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    const url = `${this.wsURL}/?token=${encodeURIComponent(this.token)}&sendID=${encodeURIComponent(this.agentUserID)}&platformID=${this.platformID}`;
    log.info(`正在连接: ${this.agentUserID} -> ${this.wsURL}`);

    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      log.info(`已连接: ${this.agentUserID}`);
      this.reconnectDelay = 1000;
    });
    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch (err) {
        log.error(`消息解析失败: ${this.agentUserID}`, err);
      }
    });
    this.ws.on('close', (code) => {
      log.info(`已断开: ${this.agentUserID} (code=${code})`);
      this.ws = null;
      this.scheduleReconnect();
    });
    this.ws.on('error', (err) => {
      log.error(`连接错误: ${this.agentUserID}, ${err.message}`);
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    log.info(`将在 ${delay}ms 后重连: ${this.agentUserID}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  disconnect() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.on('close', () => {});
      this.ws.close();
      this.ws = null;
    }
  }

  handleMessage(msg) {
    const reqIdentifier = msg.reqIdentifier;
    if (!reqIdentifier) return;

    let data = {};
    if (msg.data && typeof msg.data === 'string') {
      try {
        data = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf-8'));
      } catch {
        try {
          data = JSON.parse(msg.data);
        } catch {
          data = {};
        }
      }
    }

    if (reqIdentifier === 2001 && this.onMessage) {
      this.onMessage({
        msgData: data.msgData || data,
        conversationID: data.conversationID || data.msgData?.conversationID || '',
      });
    }

    if (reqIdentifier === 2002 && this.onPatch) {
      this.onPatch({
        serverMsgId: data.serverMsgId || data.serverMsgID,
        contentPatch: data.contentPatch,
        isFinished: data.isFinished,
        isRevoked: data.isRevoked,
        hasRead: data.hasRead,
      });
    }
  }
}
