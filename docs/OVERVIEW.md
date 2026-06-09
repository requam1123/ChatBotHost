# ChatBotHost — Overview

## What is ChatBotHost?

ChatBotHost is a standalone Node.js service that bridges an IM (Instant Messaging)
platform with LLM-powered AI agents. It:

- Listens for IM messages via **WebSocket** or **HTTP push**.
- Routes messages to the appropriate **agent** (each agent has its own AI persona).
- Executes **tool calls** (file I/O, shell commands, sub-agent delegation) in a sandboxed workspace.
- Returns AI-generated replies back to the IM conversation, including streaming text updates.
- Supports **multi-agent collaboration** (planner → coder → reviewer pipelines).
- Persists everything as **JSON files on disk** — no database required.

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         IM Server                                 │
│                 (WebSocket + REST API)                            │
│                                                                   │
│    new message ──► [WS] handleIncomingMessage()                   │
│    new message ──► [HTTP] POST /im/events/message                │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                     ChatBotHost Server                             │
│                                                                    │
│  ┌─────────────┐    ┌─────────────┐    ┌──────────────────────┐   │
│  │   Routes     │    │  Logger     │    │  HTTP Server (CORS) │   │
│  │  (29 APIs)   │    │  (stdout)   │    │  createJsonServer() │   │
│  └──────┬───────┘    └─────────────┘    └──────────────────────┘   │
│         │                                                          │
│         ├──► runMockAgentReply(runID, agent, event)                │
│         │       │                                                  │
│         │       ├──► buildAgentReplyForRuntime()                   │
│         │       │       │                                          │
│         │       │       ├──► LangChain Agent (primary)             │
│         │       │       │       └──► fallback                      │
│         │       │       ├──► Provider Loop (openai-tools)          │
│         │       │       │       └──► fallback                      │
│         │       │       └──► Mock Reply (hard fallback)            │
│         │       │                                                  │
│         │       └──► LangGraph (planner-worker, groups)            │
│         │                                                          │
│         └──► ExecuteToolCall(toolID, args)                         │
│                 │                                                  │
│                 ├──► get_current_time                              │
│                 ├──► read_conversation_messages                    │
│                 ├──► send_im_message                               │
│                 ├──► delegate_to_agent (sub-agent)                 │
│                 ├──► workspace_read / workspace_write              │
│                 └──► bash (shell in sandbox)                       │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                   Data Store (JSON files)                     │ │
│  │                                                               │ │
│  │  data/credentials.json    — API keys + base URLs              │ │
│  │  data/agents.json         — Agent configs                     │ │
│  │  data/agent-runs.json     — Execution history                 │ │
│  │  data/workspaces.json     — Workspace records                 │ │
│  │  data/conversation-workspaces.json — CV ↔ workspace mappings  │ │
│  │  data/pending-plans.json  — Group plan confirmations          │ │
│  └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### 1. Agent

An **agent** is an AI persona that responds to IM messages. Each agent has:

- A **template** (planner, coder, chatgpt, reviewer) that provides defaults
- A **credential** that supplies the API key and base URL for LLM calls
- A **model** selection (e.g. `gpt-4o-mini`)
- A set of **enabled tools** (which tools the agent is allowed to call)
- A **runtime** that determines how tool calls are processed

Agents are created from the marketplace (`POST /market/agents/:templateID/add`)
and can be customized via `PATCH /my/agents/:userAgentID`.

The special user `anonymous` can own agents and credentials that are visible to
everyone. This allows a "default" setup that all users share.

### 2. Credential

A **credential** stores API connection info:

| Field | Example |
|-------|---------|
| `name` | `My OpenAI Key` |
| `apiKey` | `sk-proj-...` |
| `baseUrl` | `https://api.openai.com/v1` |
| `modelName` | `gpt-4o-mini` |
| `provider` | `openai` |

A complete credential entry consists of `name`, `apiKey`, `baseUrl`, `modelName`, and `provider`.
If an agent does not specify a model, the credential's `modelName` is used as fallback.
Multiple credentials can exist per user. An agent references exactly one credential
via `credentialID`. At reply time, the system looks up the credential to get the
API key, base URL, model, and provider for the LLM call.

Anonymous credentials are readable (but not deletable) by any user.

### 3. Workspace

A **workspace** is a sandboxed directory where agents perform file operations.

- **target path**: the original source directory
- **sandbox path**: a copy of the target, isolated for agent operations
- Changes in the sandbox are previewed as **patches** and must be approved before applying to the real repository

### 4. Tool

A **tool** is a function that an agent can invoke during a conversation loop.
The LLM decides which tool to call and with what arguments. ChatBotHost executes
the tool and returns the result to the LLM for its next reasoning step.

Built-in tools:

| Tool | What it does |
|------|-------------|
| `get_current_time` | Returns current server time |
| `read_conversation_messages` | Reads IM conversation history |
| `send_im_message` | Sends a message to the IM server |
| `delegate_to_agent` | Delegates a subtask to another agent |
| `workspace_read` | Reads a file from the sandbox |
| `workspace_write` | Writes a file to the sandbox |
| `bash` | Executes a shell command in the sandbox |

### 5. Run

A **run** is a single agent execution — from receiving an IM message to sending
the final reply. Each run records:

- The request event (message content, sender, conversation)
- The agent that responded
- All tool calls executed
- Artifacts and approvals
- Timing and result status

Runs are stored in `agent-runs.json` for history and debugging.

### 6. Patch

When an agent writes files via `workspace_write`, the changes are only in the
sandbox. A **patch** is a diff between the sandbox and the real repository:

1. **Preview**: `POST .../patch/preview` generates unified diffs
2. **Apply**: `POST .../patch/apply` copies approved files to the repo

Protected paths (`.git/`, `node_modules/`, `token`, `data/`, `.env*`) are
blocked from patch application.

---

## Reply Pipeline

When an IM message arrives, the system follows a **layered fallback chain**:

### 1. LangChain Agent (preferred)

A LangChain `createAgent()` instance with real Zod-typed tools. The agent can
call tools in a loop (up to 10 recursion steps), accumulating tool results.
Produces structured `{ content, toolCalls, provider, endpoint, model }`.

If the LangChain agent throws an error without any tool calls executed, or if
LangChain is not available, it falls through to the provider loop.

### 2. Provider Loop (openai-tools)

A hand-written loop calling `POST /chat/completions` with OpenAI-compatible
tool definitions. Supports up to 3 rounds of tool calls. This is the fallback
when LangChain fails.

### 3. Mock Reply (hard fallback)

If both LangChain and the provider loop fail (e.g., no valid credential, network
error), a static mock message is returned:
`"{agent.nickname} 暂时无法连接模型，已收到你的消息：{content}"`.

---

## Group Collaboration

For group chats with `@mentions`, a **Planner-Worker** pattern is used:

1. **Planner agent** receives the message and formulates a plan
2. **Worker agent** (typically a Coder) executes the task
3. Optionally, a **Reviewer agent** reviews the output
4. The Planner synthesizes a final response for the group

This flow can run via:
- **LangGraph Supervisor** (preferred, with visible progress messages)
- **Legacy manual orchestration** (fallback with IM progress messages)

Group members' agent IDs are discovered from the IM server's group member list.

---

## WebSocket Connection

Agents maintain persistent WebSocket connections to the IM server for real-time
message push. On startup (and after agent creation), each agent connects:

- Connect with token-based authentication
- Listen for `reqIdentifier=2001` (new messages) and `reqIdentifier=2002` (message patches)
- Auto-reconnect with exponential backoff (1s → 2s → 4s → ... → 30s max)
- Disconnection on agent deletion via `disconnect()`

---

## Data Persistence

All data is stored as plain JSON files in the `data/` directory:

| File | Collection | Schema |
|------|-----------|--------|
| `credentials.json` | `credentials` | `{ credentialID, ownerUserID, name, apiKey, baseUrl, modelName, provider, createTime, updateTime }` |
| `agents.json` | `agents` | `{ userAgentID, ownerUserID, templateID, imAgentUserID, nickname, avatarURL, credentialID, model, systemPrompt, enabledToolIDs, runtime, workerTemplateID, workerAgentUserID, status, createTime, updateTime }` |
| `agent-runs.json` | `agent-runs` | `{ runID, parentRunID, rootRunID, runType, userAgentID, imAgentUserID, ownerUserID, conversationID, groupID, requestServerMsgID, responseServerMsgID, status, mode, runtime, provider, endpoint, model, toolCalls, artifacts, approvals, graphSteps, output, startTime, endTime, ... }` |
| `workspaces.json` | `workspaces` | `{ workspaceID, ownerUserID, name, targetPath, sandboxPath, status, createTime, updateTime }` |
| `conversation-workspaces.json` | `conversation-workspaces` | `{ ownerUserID, conversationID, workspaceID, createTime, updateTime }` |
| `pending-plans.json` | `pending-plans` | `{ pendingPlanID, runID, ownerUserID, groupID, plannerAgentID, workerAgentID, task, planText, status, createTime, ... }` |

---

## Startup Sequence

```
1. loadConfig()           — read environment variables
2. new JsonStore(dir)     — initialize file-based storage
3. new ImClient(url)      — initialize IM REST client
4. createLangGraphRuntime() — dynamic import (@langchain/langgraph)
5. createLangGraphSupervisorRuntime()
6. seedData(store)        — bootstrap anonymous credential + agents if missing
7. createJsonServer()     — build route dispatcher
8. server.listen(port)    — start HTTP
```

---

## Configuration

All configuration comes from environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHATBOT_HOST_PORT` | `3100` | HTTP listen port |
| `IM_SERVER_BASE_URL` | `http://localhost:3000` | IM server REST base URL |
| `IM_SERVER_WS_URL` | `ws://localhost:3000` | IM server WebSocket base URL |
| `CHATBOT_HOST_STORAGE_DIR` | `../data/` (relative to src/) | JSON file storage |
| `CHATBOT_HOST_WORKSPACE_ROOT` | `../workspaces/` | Sandbox root |
| `CHATBOT_HOST_REPO_ROOT` | `../` | Repository root |

On first startup, `seedData()` optionally migrates `ARK_API_KEY` and `ARK_BASE_URL`
environment variables into the anonymous credential (one-time only).

---

## Dependencies

```json
{
  "@langchain/core": "^1.1.48",
  "@langchain/langgraph": "^1.3.6",
  "@langchain/openai": "^1.4.7",
  "langchain": "^1.4.4",
  "ws": "^8.21.0",
  "zod": "^4.4.3"
}
```

- **langchain** + **@langchain/openai** — primary agent runtime
- **@langchain/langgraph** — graph-based multi-agent orchestration
- **ws** — WebSocket client for IM push events
- **zod** — tool argument schema validation
- **No database driver** — everything is JSON files on disk
