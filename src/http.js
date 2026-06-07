import { createServer } from 'node:http';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createJsonServer(routes) {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, JSON_HEADERS);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', 'http://localhost');
      const route = routes.find((candidate) => {
        if (candidate.method !== req.method) return false;
        const match = candidate.pattern.exec(url.pathname);
        if (!match) return false;
        req.params = match.groups || {};
        return true;
      });

      if (!route) {
        sendJson(res, 404, { errCode: 404, errMsg: 'Not Found' });
        return;
      }

      const body = await readJsonBody(req);
      const data = await route.handler({ req, url, body, params: req.params || {} });
      sendJson(res, 200, { errCode: 0, errMsg: '', data });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      sendJson(res, status, { errCode: status, errMsg: message });
    }
  });
}

export function sendJson(res, status, payload) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.method === 'GET') return {};

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) {
      throw new HttpError(413, 'Request body too large');
    }
  }

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}
