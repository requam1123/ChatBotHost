# ChatBotHost — API Reference

> All responses follow `{ errCode, errMsg, data }`. Success: `errCode: 0`.
> All responses include CORS headers (`access-control-allow-origin: *`).

---

## Common patterns

- **Path params** (e.g. `:userAgentID`) are extracted from named regex capture groups in the route pattern.
- **Query string params** are read from `url.searchParams`.
- **JSON body** is parsed from the request body (1 MB max). GET requests have no body.
- **`ownerUserID`** appears on most endpoints — identifies the requesting user.
- **`anonymous`** is a special user ID: anonymous agents/credentials are visible to all users.

---

## Health & Info

### `GET /health`

Return service status.

**Response:**
```json
{
  "status": "ok",
  "service": "ChatBotHost",
  "imServerBaseURL": "http://localhost:3000",
  "langGraphRuntime": { "available": true, "source": "@langchain/langgraph", "error": "" },
  "langGraphSupervisorRuntime": { "available": false, "source": "@langchain/langgraph", "error": "..." },
  "time": 1718000000000
}
```

### `GET /tools?agentTemplateID=coder`

List all tools, optionally filtered by a template's allowed tool IDs.

**Query params:**

| Param | Required | Description |
|-------|----------|-------------|
| `agentTemplateID` | No | Template ID to filter tools. Throws 404 if template not found. |

### `GET /market/agents`

List all active agent templates with their default tools populated.

### `GET /debug/tool-catalog`

Return the raw tool catalog (all tool definitions).

---

## Credentials

> Credentials store API keys, base URLs, model names, and provider info. The `anonymous` user's credentials are visible to everyone.

### `GET /credentials?ownerUserID=xxx`

List credentials owned by the user plus all anonymous credentials.

| Param | Location | Required |
|-------|----------|----------|
| `ownerUserID` | query | **Yes** |

**Response:**
```json
{
  "credentials": [
    {
      "credentialID": "cred_xxx",
      "ownerUserID": "anonymous",
      "name": "My OpenAI Key",
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1",
      "modelName": "gpt-4o-mini",
      "provider": "openai",
      "createTime": 1718000000000,
      "updateTime": 1718000000000
    }
  ],
  "total": 1
}
```

### `POST /credentials`

Create a credential.

| Param | Location | Required | Description |
|-------|----------|----------|-------------|
| `ownerUserID` | body | **Yes** | |
| `apiKey` | body | **Yes** | |
| `baseUrl` | body | **Yes** | e.g. `https://api.openai.com/v1` |
| `name` | body | No | Display name for the credential |
| `modelName` | body | No | Default model for this credential |
| `provider` | body | No | Default `"openai"` |

### `GET /credentials/:credentialID?ownerUserID=xxx`

Read one credential. Must be owned by the user or be anonymous.
Throws 403 if owner mismatch (when `ownerUserID` is provided).

### `PATCH /credentials/:credentialID?ownerUserID=xxx`

Update `apiKey`, `baseUrl`, `name`, `modelName`, and/or `provider` on a credential.
Must be owned by the user (anonymous is updatable by anyone).
Throws 403 if owner mismatch.

### `DELETE /credentials/:credentialID?ownerUserID=xxx`

Delete a credential. The `anonymous` credential cannot be deleted (throws 403).
Must be owned by the user.

---

## Agents

> Agent objects are stored in the `agents` collection. Each agent is bound to an owner and references a credential for LLM access.

**Agent object schema:**
```json
{
  "userAgentID": "ua_xxx",
  "ownerUserID": "anonymous",
  "templateID": "coder",
  "imAgentUserID": "agent_coder_anonymous",
  "nickname": "Coder Agent",
  "avatarURL": "https://...",
  "credentialID": "cred_xxx",
  "model": "gpt-4o-mini",
  "systemPrompt": "You are a coding agent...",
  "enabledToolIDs": ["get_current_time", "workspace_read", "workspace_write", "bash"],
  "runtime": "openai-tools",
  "workerTemplateID": "",
  "workerAgentUserID": "",
  "status": "active",
  "createTime": 1718000000000,
  "updateTime": 1718000000000
}
```

### `GET /my/agents?ownerUserID=xxx`

List agents owned by `ownerUserID`.

| Param | Location | Required |
|-------|----------|----------|
| `ownerUserID` | query | **Yes** |

### `GET /my/agents/:userAgentID`

Read a single agent by ID. Throws 404 if not found.

### `PATCH /my/agents/:userAgentID`

Update an agent. Accepted fields (all optional):

| Field | Type | Notes |
|-------|------|-------|
| `nickname` | string | |
| `avatarURL` | string | |
| `credentialID` | string | Switch which credential to use |
| `model` | string | e.g. `gpt-4o` |
| `systemPrompt` | string | |
| `runtime` | string | Must be one of: `openai-tools`, `langgraph-planner-worker`, `langchain-agent`, `langgraph-supervisor` |
| `workerTemplateID` | string | |
| `workerAgentUserID` | string | |
| `enabledToolIDs` | string[] | Only existing tool IDs are accepted |

Side effects: re-registers on IM server, reconnects WebSocket.

### `POST /market/agents/:templateID/add`

Create a new agent instance from a market template.

| Field | Location | Required | Default |
|-------|----------|----------|---------|
| `templateID` | path | **Yes** | — |
| `ownerUserID` | body | **Yes** | — |
| `nickname` | body | No | Template name |
| `avatarURL` | body | No | Template avatar |
| `credentialID` | body | No | `""` (falls back to anonymous credential at reply time) |
| `model` | body | No | Template default model |
| `systemPrompt` | body | No | Template default prompt |
| `enabledToolIDs` | body | No | Template default tools |
| `runtime` | body | No | Template default runtime |
| `workerTemplateID` | body | No | Template default worker |
| `workerAgentUserID` | body | No | `""` |

Returns `{ agent, created: true }`. If the same owner + template already exists, returns `{ agent: <existing>, created: false }`.

Side effects: registers IM agent user, ensures friend pair, starts WebSocket.

### `POST /my/agents/:userAgentID/test`

Test the agent's provider connectivity. Sends a one-shot "Say hello" message.

The entire request body is passed as overrides to the agent config for the test call.

**Response (success):**
```json
{ "ok": true, "provider": "openai", "endpoint": "https://...", "model": "gpt-4o-mini", "message": "Hello!" }
```

**Response (failure):**
```json
{ "ok": false, "provider": "openai", "endpoint": "https://...", "model": "gpt-4o-mini", "message": "Provider test failed." }
```

### `POST /my/agents/:userAgentID/graph/delegate-test`

Test LangGraph planner→worker delegation. Requires LangGraph runtime to be available (throws 503 otherwise).

| Field | Location | Required | Description |
|-------|----------|----------|-------------|
| `userAgentID` | path | **Yes** | Planner agent |
| `task` | body | **Yes** | Task description |
| `agentUserID` | body | No | Worker agent IM user ID |
| `templateID` | body | No | Worker template ID (default `coder`) |
| `conversationID` | body | No | Conversation ID |
| `context` | body | No | Additional context string |

**Response:**
```json
{
  "runtime": "langgraph",
  "durationMs": 1234,
  "plannerAgentID": "ua_xxx",
  "workerAgentID": "ua_yyy",
  "task": "Write hello world",
  "workerOutput": "...",
  "finalOutput": "...",
  "steps": [...]
}
```

---

## Agent Runs

> Execution history records. Each run captures the conversation, tool calls, artifacts, and approvals.

### `GET /my/agents/:userAgentID/runs?limit=20`

List run history for an agent, sorted by most recent. Limit clamped to `[1, 100]`, default 20.

### `GET /my/agents/:userAgentID/runs/:runID`

Read a single run record. Throws 404 if not found for that agent.

### `GET /runs/by-message/:serverMsgID?ownerUserID=xxx`

Look up a run by its IM server message ID. Matches against `responseServerMsgID`, `output.serverMsgID`, or any `graphStep.serverMsgID`. Throws 404 if not found.

---

## Patch (Code Review & Approval)

> When an agent writes files in the sandbox, changes can be previewed as diffs and applied to the real repository.

### `POST /my/agents/:userAgentID/runs/:runID/patch/preview`

Generate a diff preview for files changed during the run. The request body is passed through to `createPatchPreview`.

**Response:**
```json
{
  "proposal": {
    "proposalID": "patch_1718000000000",
    "status": "pending",
    "files": [
      {
        "sandboxPath": "src/main.js",
        "targetPath": "src/main.js",
        "status": "modify",
        "beforeBytes": 1024,
        "afterBytes": 1100,
        "diff": "@@ -1,5 +1,6 @@\n ..."
      }
    ]
  },
  "run": { "<updated run with patchProposal and artifacts>" }
}
```

### `POST /my/agents/:userAgentID/runs/:runID/patch/apply`

Apply the currently pending patch proposal from this run. Copies files from sandbox to target repo.

---

## Workspaces

> Workspaces isolate agent file operations. Each workspace has a `sandboxPath` (where the agent works) and a `targetPath` (original source).

### `GET /workspaces?ownerUserID=xxx`

List all workspaces owned by a user.

### `POST /workspaces`

Create a new workspace from an existing directory.

| Field | Location | Required | Description |
|-------|----------|----------|-------------|
| `ownerUserID` | body | **Yes** | |
| `targetPath` | body | **Yes** | Source directory to seed from |
| `name` | body | No | Display name |

### `GET /filesystem/directories?path=xxx`

Browse local filesystem directories for workspace target selection.
Path defaults to the first root (repo root).
Throws 400 if path not found, 403 if not readable.

**Response:**
```json
{
  "currentPath": "E:\\Projects\\...",
  "parentPath": "E:\\Projects",
  "roots": [
    { "name": "项目根目录", "path": "E:\\Projects\\..." },
    { "name": "工作区目录", "path": "E:\\Projects\\...\\workspaces" },
    { "name": "用户目录", "path": "C:\\Users\\..." }
  ],
  "directories": [
    { "name": "src", "path": "E:\\Projects\\...\\src" },
    { "name": "docs", "path": "E:\\Projects\\...\\docs" }
  ]
}
```

### `GET /conversations/:conversationID/workspace?ownerUserID=xxx&autoCreate=1`

Get or optionally auto-create the workspace bound to a conversation.
Set `autoCreate=1` to create one if none exists.

### `POST /conversations/:conversationID/workspace`

Bind a workspace to a conversation.

| Field | Location | Required |
|-------|----------|----------|
| `ownerUserID` | body | **Yes** |
| `workspaceID` | body | **Yes** |

### `GET /workspaces/:workspaceID/files?ownerUserID=xxx&source=sandbox&dir=`

List files in a workspace.

| Param | Location | Required | Default |
|-------|----------|----------|---------|
| `ownerUserID` | query | **Yes** | — |
| `source` | query | No | `sandbox` (or `target`) |
| `dir` | query | No | `""` |

### `GET /workspaces/:workspaceID/file?ownerUserID=xxx&path=src/main.js&source=sandbox`

Read a file from a workspace.

| Param | Location | Required |
|-------|----------|----------|
| `ownerUserID` | query | **Yes** |
| `path` | query | **Yes** |
| `source` | query | No |

**Response:**
```json
{ "path": "src/main.js", "content": "...", "bytes": 1024, "source": "sandbox" }
```

### `POST /workspaces/:workspaceID/file`

Write a file to a workspace (sandbox only).

| Field | Location | Required | Description |
|-------|----------|----------|-------------|
| `ownerUserID` | body | **Yes** | |
| `path` | body | **Yes** | File path within workspace |
| `content` | body | No | File content (empty string default) |

---

## IM Event Handling

### `POST /im/events/message`

Accept an incoming IM message and trigger an agent reply (fire-and-forget).
The reply runs asynchronously; the response returns immediately with the run ID.

| Field | Location | Required | Default |
|-------|----------|----------|---------|
| `conversationID` | body | **Yes** | — |
| `sendID` | body | **Yes** | — |
| `recvID` | body | **Yes** | Must match an agent's `imAgentUserID` |
| `groupID` | body | No | `""` |
| `content` | body | No | `""` |
| `serverMsgID` | body | No | `""` |
| `contentType` | body | No | `101` |
| `sessionType` | body | No | `1` |
| `atUserIDList` | body | No | `[]` |
| `mentionedAgentIDs` | body | No | `[]` |

**Response:** `{ "accepted": true, "runID": "run_xxx" }`
