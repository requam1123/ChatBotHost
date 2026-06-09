# ChatBotHost — Code Structure

> Each source file under `src/`, ordered by dependency layer.

---

## Foundation layer

### `src/logger.js`
Zero-dependency structured logging utility.

- `createLogger(context)` → `{ info, warn, error, debug }` bound to a context tag
- `setLogLevel(level)` → runtime control: `DEBUG` | `INFO` | `WARN` | `ERROR`
- Output format: `[YYYY-MM-DD HH:mm:ss.SSS] [LEVEL] [CONTEXT  ] message...`
- Errors automatically include `.stack` on their own line.

### `src/config.js`
Startup configuration aggregator. Reads environment variables only:

| Env Var | Default | Purpose |
|----------|---------|---------|
| `CHATBOT_HOST_PORT` | `3100` | HTTP listen port |
| `IM_SERVER_BASE_URL` | `http://localhost:3000` | IM server REST API |
| `IM_SERVER_WS_URL` | `ws://localhost:3000` | IM server WebSocket |
| `CHATBOT_HOST_STORAGE_DIR` | `../data/` | JSON file storage |
| `CHATBOT_HOST_WORKSPACE_ROOT` | `../workspaces/` | Workspace sandbox root |
| `CHATBOT_HOST_REPO_ROOT` | `../` | Repository root |

No `ARK_*` or API key env vars here — credentials are managed via the API.

### `src/storage.js`
File-based JSON collection store (`JsonStore`).

- `readCollection(name)` — reads `data/<name>.json`, returns `[]` if missing
- `writeCollection(name, value)` — writes pretty-printed JSON
- One file per logical collection, all arrays

### `src/http.js`
Lightweight HTTP server + JSON API framework.

- `createJsonServer(routes)` — method + regex route dispatcher
- `HttpError` — custom error with HTTP status code
- `sendJson(res, status, payload)` — CORS + JSON response
- `readJsonBody(req)` — 1 MB body parser
- Response shape: `{ errCode, errMsg, data }`

---

## Data layer

### `src/market.js`
Agent template catalog. Hardcoded templates:

| TemplateID | Role | Default Runtime |
|------------|------|-----------------|
| `planner` | Planning / orchestration | `openai-tools` |
| `coder` | Coding / file editing | `openai-tools` |
| `chatgpt` | General conversation | `openai-tools` |
| `reviewer` | Code review | `openai-tools` |

Provides `listActiveTemplates()` and `getTemplate(id)`.

### `src/run-records.js`
Normalization helpers for agent run records. Sanitizes and deduplicates
`toolCalls`, `approvals`, `graphSteps`, and `artifacts` arrays.

### `src/workspace-manager.js`
Sandboxed workspace lifecycle.

- `createWorkspace` — copies target dir into sandbox (excludes `.git`, `node_modules`)
- `listWorkspaceFiles` / `readWorkspaceFile` / `writeWorkspaceFile` — sandbox-aware I/O with path-escape protection
- `bindConversationWorkspace` / `getConversationWorkspace` — conversation ↔ workspace mapping
- `resolveEventWorkspace` — extracts workspace context from IM event
- Path sandboxing via `resolveInside()` — prevents `../` escapes

---

## Tool layer

### `src/tools.js`
Tool execution engine. Currently defines **7 built-in tools**:

| ToolID | Category | Risk | Description |
|--------|----------|------|-------------|
| `get_current_time` | safe_read | low | Return server time |
| `read_conversation_messages` | safe_read | low | Read IM conversation history |
| `send_im_message` | external_api | medium | Send IM message as agent |
| `delegate_to_agent` | external_api | medium | Delegate task to another agent |
| `workspace_read` | workspace_read | high | Read file from sandbox |
| `workspace_write` | workspace_write | critical | Write file to sandbox |
| `bash` | shell | critical | Run shell command in sandbox |

Exports `listTools()`, `findTools()`, `toOpenAITools()` for OpenAI-compatible
tool conversion, and `executeToolCall()` as the central dispatch.

### `src/patch-manager.js`
Diff-based patch proposal/apply workflow.

- `createPatchPreview` — generates unified diffs between sandbox and repo
- `applyPatchProposal` — copies approved files from sandbox to repo
- Protected paths: `.git/`, `node_modules/`, `token`, `data/`, `.env`, etc.

---

## Provider / LLM layer

### `src/providers.js`
OpenAI-compatible LLM provider integration.

- `resolveProviderConfig(store, agent)` — **async** — looks up `agent.credentialID` in the credentials collection, falls back to `anonymous`. Returns `{ provider, baseURL, apiKey, model }`.
- `generateAgentReply(store, agent, event, options)` — main LLM chat loop with tool-call support (max 3 rounds)
- `testAgentProvider(store, agent, overrides)` — connectivity test
- `callOpenAICompatible()` — sends `POST .../chat/completions`, handles tool-call responses
- `requestChatCompletion()` — raw HTTP fetch with Bearer auth

### `src/langchain-agent-runtime.js`
LangChain-based agent runtime (primary runtime).

- `generateLangChainAgentReply(store, agent, event, options)` — creates a LangChain `ChatOpenAI` agent with Zod schemas for each tool, invokes with `recursionLimit: 10`, falls back to summarizing tool calls if recursion limit is hit.

### `src/langgraph-runtime.js`
LangGraph Planner→Worker graph runtime.

- `createLangGraphRuntime()` — dynamic `@langchain/langgraph` import
- `runPlannerWorkerGraph()` — 3-node graph: planner → worker → summary
- Planner strips tools from its agent; worker is the delegated agent

### `src/langgraph-supervisor-runtime.js`
LangGraph Supervisor runtime for visible group collaboration.

- `createLangGraphSupervisorRuntime()` — dynamic import
- `runVisibleSupervisorGraph()` — multi-node graph with injected callbacks for IM message sending, supports planner → worker → reviewer → summary pipelines

---

## IM / Messaging layer

### `src/im-client.js`
REST client for the IM server.

- `getToken(userID, platformID)` — obtain auth token
- `registerAgentUser(...)` — register agent on IM server
- `ensureFriendPair(ownerID, agentID)` — establish friend relationship
- `getGroupMembers(groupID, requesterID)` — list group members
- `sendMessage(...)` — send text message (DM or group)
- `patchMessage(serverMsgId, content, isFinished)` — stream-update a message

### `src/im-ws-client.js`
WebSocket client for IM push events.

- `ImWsClient` class — connects, auto-reconnects with exponential backoff
- Handles `reqIdentifier=2001` (new message) and `reqIdentifier=2002` (message patch)
- Dispatches to `onMessage` / `onPatch` callbacks

---

## Entry point

### `src/index.js`
Main server. **~2000 lines** — the largest file.

**Startup sequence:**
1. `loadConfig()` — read env vars
2. `new JsonStore(config.storageDir)` — initialize file storage
3. `new ImClient(config.imServerBaseURL)` — IM REST client
4. `createLangGraphRuntime()` / `createLangGraphSupervisorRuntime()` — dynamic runtime loading
5. `seedData(store)` — bootstrap anonymous credentials + agents if missing
6. `createJsonServer(routes).listen(config.port)` — start HTTP

**29 API routes** — see `API.md` for full reference.

**Key internal functions:**
- `handleIncomingMessage(payload)` — WebSocket message → event parsing → dispatch
- `runMockAgentReply(runID, agent, event)` — main agent reply pipeline
- `buildAgentReplyForRuntime(agent, event, runContext)` — runtime dispatcher
- `buildAgentReply(agent, event, runContext)` — LangChain → provider → mock fallback chain
- `delegateToAgent()` — inter-agent task delegation
- `buildGraphNodeReply()` — LangGraph node reply generation
- `resolveGroupCollaborationAgents()` — group member agent discovery
- Various group collaboration flows: plan confirmation, visible collaboration, supervisor-based

---

## Data collections (stored as JSON files under `data/`)

| File | Purpose |
|------|---------|
| `credentials.json` | API key storage (credentialID, ownerUserID, name, apiKey, baseUrl, modelName, provider) |
| `agents.json` | Agent configurations (userAgentID, ownerUserID, templateID, credentialID, model, tools, runtime, etc.) |
| `agent-runs.json` | Execution history (runID, agent, event, toolCalls, artifacts, approvals, duration) |
| `pending-plans.json` | Group plan confirmations awaiting user approval |
| `workspaces.json` | Workspace records (sandbox path, target path, owner) |
| `conversation-workspaces.json` | Conversation ↔ workspace bindings |
