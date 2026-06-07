# ChatBotHost

ChatBotHost is the agent management and orchestration service for the IM system.

This first implementation is intentionally dependency-free:

- model marketplace templates
- backend-owned tools catalog
- user-agent binding storage
- bridge calls to the existing IM server

## Run

```bash
pnpm start
```

Defaults:

- ChatBotHost: `http://localhost:3100`
- IM server: `http://localhost:3000`

Override with environment variables:

```bash
CHATBOT_HOST_PORT=3100 IM_SERVER_BASE_URL=http://localhost:3000 pnpm start
```

## Smoke Test

```bash
curl http://localhost:3100/health
curl http://localhost:3100/tools
curl http://localhost:3100/market/agents
```

Add an agent for an IM user:

```bash
curl -X POST http://localhost:3100/market/agents/planner/add \
  -H 'Content-Type: application/json' \
  -d '{"ownerUserID":"alice"}'
```
