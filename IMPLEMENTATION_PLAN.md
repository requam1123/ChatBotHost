# ChatBotHost 实现方案

## 目标

ChatBotHost 是独立于现有 IM 后端的 Agent 管理与编排服务。它负责创建、配置、运行、隔离和审计 Agent，并通过现有 IM 后端完成用户、好友、单聊、群聊和消息投递。

现有 `LLM_IM_SDK_Server` 继续承担 IM 基础能力：

- 用户、好友、群组、会话、消息存储
- WebSocket 推送
- 文件上传
- 基础 Agent 用户标记

ChatBotHost 新增能力：

- 模型广场 Agent 模板管理
- 用户添加 Agent 后的用户-Agent 绑定
- 默认配置、用户绑定配置、会话配置三层隔离
- Agent 运行时、工具权限、流式响应
- 群聊多 Agent 协作和 `@agent` 路由
- 工具调用审计和高风险动作审批

## 技术选型

### Agent Runtime

采用 LangChain JS/TS v1 的 `createAgent` 作为第一版 agent harness。它已经内置 ReAct 风格的 model/tool 循环，并基于 LangGraph 运行时，可以直接支持工具调用、流式事件、middleware、checkpoint 和多轮 thread。

不用在第一版直接上 DeepAgents 作为主 runtime。DeepAgents 更适合长任务编码/研究类代理，包含 filesystem、subagents、planning 等高级能力，但对当前 IM 产品来说，权限面太大。第一版应先用 `createAgent` 组合受控 tools，后续给 Coder Agent 单独升级 DeepAgents 能力。

### 数据库

建议 ChatBotHost 自己维护 MongoDB collections，可以使用和 IM 后端同一个 Mongo 实例，但独立 collection 前缀：

- `cbh_agent_template`
- `cbh_user_agent`
- `cbh_agent_session_config`
- `cbh_tool_catalog`
- `cbh_tool_grant`
- `cbh_agent_run`
- `cbh_tool_call_log`
- `cbh_secret_ref`

不要把 Agent 配置直接写进 IM `user` 或 `conversation` collection。IM 后端只保留最小必要字段，例如 Agent 作为一个 `user` 存在，并带 `isAgent: true`。

## 核心数据模型

### AgentTemplate

模型广场展示的模板。

```ts
interface AgentTemplate {
  templateID: string;
  name: string;
  avatarURL: string;
  provider: 'openai' | 'anthropic' | 'openrouter' | 'ollama' | 'custom';
  defaultEndpoint?: string;
  defaultModel: string;
  defaultSystemPrompt: string;
  defaultToolIDs: string[];
  description: string;
  tags: string[];
  status: 'active' | 'disabled';
  createTime: number;
  updateTime: number;
}
```

### UserAgent

用户从模型广场添加后的 Agent 实例。它会绑定一个 IM 用户 ID，使它能进入好友列表和群聊。

```ts
interface UserAgent {
  userAgentID: string;
  ownerUserID: string;
  templateID: string;
  imAgentUserID: string;
  nickname: string;
  avatarURL: string;
  provider: string;
  endpoint?: string;
  model: string;
  systemPrompt: string;
  secretRefID?: string;
  enabledToolIDs: string[];
  status: 'active' | 'disabled';
  createTime: number;
  updateTime: number;
}
```

### AgentSessionConfig

会话级配置。每个 Agent 在每个单聊/群聊都可以覆盖默认配置。

```ts
interface AgentSessionConfig {
  sessionConfigID: string;
  ownerUserID: string;
  userAgentID: string;
  imAgentUserID: string;
  conversationID: string;
  sessionType: 1 | 2 | 3;
  nickname?: string;
  provider?: string;
  endpoint?: string;
  model?: string;
  systemPrompt?: string;
  secretRefID?: string;
  enabledToolIDs?: string[];
  runtimeOptions: {
    maxIterations: number;
    temperature?: number;
    maxTokens?: number;
  };
  createTime: number;
  updateTime: number;
}
```

配置解析顺序：

1. `AgentTemplate`
2. `UserAgent`
3. `AgentSessionConfig`

最终运行配置 = 模板默认配置 + 用户绑定配置 + 会话覆盖配置。

## 服务边界

### ChatBotHost API

面向前端：

- `GET /market/agents`
- `POST /market/agents/:templateID/add`
- `GET /my/agents`
- `PATCH /my/agents/:userAgentID`
- `POST /my/agents/:userAgentID/test`
- `GET /tools`
- `POST /sessions/:conversationID/agents/:userAgentID/config`
- `PATCH /sessions/:conversationID/agents/:userAgentID/config`
- `GET /sessions/:conversationID/agents`

面向 IM 后端：

- `POST /im/events/message`
- `POST /im/events/group_member_added`
- `POST /im/events/conversation_created`

面向内部任务：

- `POST /runs`
- `GET /runs/:runID`
- `POST /runs/:runID/cancel`
- `POST /tool-approvals/:approvalID/approve`
- `POST /tool-approvals/:approvalID/reject`

### 和 IM 后端的关系

ChatBotHost 不直接管理 IM 长连接。它通过 IM 后端 REST API 写消息、更新消息、推送流式 patch。

需要在 IM 后端补一个事件转发层：

- 单聊消息发送后，如果接收方是 Agent，转发到 ChatBotHost。
- 群聊消息发送后，如果内容包含 `@agent`，转发到 ChatBotHost。
- 用户添加 Agent 后，ChatBotHost 调用 IM 后端创建 Agent 用户并建立好友关系。

## 消息流程

### 用户添加 Agent

1. 前端在模型广场点击添加。
2. ChatBotHost 创建 `UserAgent`。
3. ChatBotHost 调用 IM `/user/user_register` 创建 `imAgentUserID`。
4. ChatBotHost 调用 IM 好友接口，把 Agent 加入用户好友列表。
5. 前端刷新好友列表，看到 Agent。

### 单聊 Agent

1. 用户给 Agent 发消息。
2. IM 后端写入用户消息。
3. IM 后端发现 `recvID` 是 Agent，调用 ChatBotHost `/im/events/message`。
4. ChatBotHost 解析最终配置，创建或恢复 LangChain thread。
5. ChatBotHost 先通过 IM 后端发送一条 Agent 占位消息。
6. Agent stream 输出内容。
7. ChatBotHost 持续调用 IM `/msg/patch_update` 更新占位消息。
8. 结束后记录 `cbh_agent_run` 和 `cbh_tool_call_log`。

### 群聊 Agent

1. 用户在群聊中发送 `@planner 帮我拆解任务`。
2. IM 后端解析 `atUserIDList` 或文本 fallback，判断目标 Agent。
3. IM 后端把事件转发到 ChatBotHost。
4. ChatBotHost 按 `conversationID + imAgentUserID` 读取会话级配置。
5. Agent 回复群聊，可在内容里 `@user` 或 `@otherAgent`。
6. 如果 Agent @ 另一个 Agent，ChatBotHost 创建新的内部任务或转发为群聊 Agent 事件，避免前端伪造。

## LangChain 运行设计

### Agent 创建

每次运行时根据最终配置动态构建 agent：

```ts
const agent = createAgent({
  model,
  tools,
  systemPrompt,
  checkpointer,
  contextSchema,
  middleware,
});
```

`thread_id` 使用稳定映射：

```txt
thread_id = `${conversationID}:${imAgentUserID}`
```

这样同一个 Agent 在同一个会话里有连续上下文，不同用户、不同会话、不同 Agent 互不污染。

### Runtime Context

每次 invoke/stream 都传入 context：

```ts
interface AgentRuntimeContext {
  ownerUserID: string;
  conversationID: string;
  userAgentID: string;
  imAgentUserID: string;
  sessionType: number;
  toolGrantIDs: string[];
  runID: string;
}
```

所有 tool 必须通过 runtime context 做权限校验，不能只靠 prompt 约束。

### Streaming

ChatBotHost 使用 agent `stream`，将消息增量转换为 IM 的 `patch_update`：

- `contentPatch`: 当前完整内容或增量内容，第一版建议传当前完整内容，前端逻辑更简单。
- `isFinished`: stream 结束时为 `true`。
- tool call 事件先不直接展示给普通用户，只写审计日志；后续可以做“执行进度” UI。

## Tools 设计

### Tools 列表从哪里来

前端展示的 tools 列表由 ChatBotHost 后端提供，不由前端硬编码。后端维护一个统一的 `ToolCatalog`，它是“可展示、可授权、可执行”的工具注册表。

工具来源分三类：

1. 内置工具：ChatBotHost 代码内实现，例如读取会话消息、发送 IM 消息、获取当前时间。
2. MCP 工具：从后端配置的 MCP server 启动/连接后发现工具，再经过 allowlist/denylist 过滤后导入。
3. 自定义 HTTP 工具：管理员或用户配置一个外部 HTTP endpoint，提供名称、描述、输入 schema 和鉴权方式。

落库后的 tools 才能给前端展示。运行时真正执行的工具也必须从这个目录解析，不能让前端传一个任意 tool name 后端就执行。

### ToolCatalog

```ts
interface ToolCatalogItem {
  toolID: string;
  name: string;
  description: string;
  category: 'safe_read' | 'external_api' | 'workspace_read' | 'workspace_write' | 'shell';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}
```

### ToolCatalog 落地流程

1. 服务启动时加载内置 tool definitions。
2. 读取后端配置中的 MCP servers，连接后发现工具。
3. 读取数据库里的自定义 HTTP tools。
4. 统一转换为 `ToolCatalogItem`，写入或更新 `cbh_tool_catalog`。
5. 前端通过 `GET /tools` 获取可选工具。
6. 添加或配置 Agent 时，前端提交选择的 `toolID[]`。
7. 后端写入 `UserAgent.enabledToolIDs` 或 `AgentSessionConfig.enabledToolIDs`。
8. Agent 运行前，后端按 owner、conversation、agent、riskLevel、approval policy 过滤最终 tools。

前端看到的是“可选工具目录”；Agent 运行时拿到的是“本次会话被授权的工具实例”。这两者必须分开。

### Tools API

```txt
GET /tools
GET /tools?agentTemplateID=planner
GET /sessions/:conversationID/agents/:userAgentID/tools
PATCH /my/agents/:userAgentID/tools
PATCH /sessions/:conversationID/agents/:userAgentID/tools
POST /tools/:toolID/test
```

`GET /tools` 返回基础目录，用于模型广场/Agent 默认配置页。`GET /sessions/.../tools` 返回某个会话里实际可用的 tools，用于会话级配置面板。

### ToolGrant

`ToolCatalog` 只说明系统有哪些工具；`ToolGrant` 说明谁能用。

```ts
interface ToolGrant {
  grantID: string;
  ownerUserID: string;
  userAgentID?: string;
  conversationID?: string;
  toolID: string;
  enabled: boolean;
  requireApproval: boolean;
  limits: {
    maxCallsPerRun?: number;
    maxCallsPerDay?: number;
    timeoutMs?: number;
  };
  createTime: number;
  updateTime: number;
}
```

权限优先级：

1. 系统级：`ToolCatalog.enabled` 和 `riskLevel`
2. 模板级：`AgentTemplate.defaultToolIDs`
3. 用户 Agent 级：`UserAgent.enabledToolIDs`
4. 会话级：`AgentSessionConfig.enabledToolIDs`
5. 授权级：`ToolGrant` 的限制和审批规则

后端最终只把通过校验的 tools 注入 LangChain `createAgent({ tools })`。

### 第一版内置 tools

低风险：

- `get_current_time`
- `summarize_conversation`
- `read_conversation_messages`
- `search_user_contacts`

中风险：

- `send_im_message`
- `create_group_task`
- `call_http_endpoint`

高风险，默认禁用：

- `workspace_read`
- `workspace_write`
- `bash`

### Bash / Read / Write 安全策略

第一版不要直接给 Agent 本机 shell。需要至少满足：

- 每个 run 一个独立 workspace。
- workspace 路径只能在 ChatBotHost 管理目录下。
- read/write 只能访问 allowlist 路径。
- bash 使用容器或受限子进程，禁止网络、限制 CPU/内存/执行时间。
- destructive 命令需要 human approval。
- 所有 tool input/output 入库审计。

建议实现顺序：

1. 先实现安全 read-only tools。
2. 再实现 scoped write。
3. 最后实现 bash，而且只给 Coder Agent 模板开放。

## 权限与隔离

必须同时校验：

- `ownerUserID` 是否拥有该 `userAgentID`
- `imAgentUserID` 是否属于该 `userAgentID`
- `conversationID` 是否包含该 Agent
- 当前会话是否允许该 tool
- 当前 tool 是否需要审批
- 当前 run 是否超过成本/步数/时间限制

不要信任前端传来的 Agent ID、tool ID、conversation ID。前端只负责选择，后端必须重新查库确认关系。

## 前端改造

### 导航

在现有聊天布局增加“模型广场”入口：

- 桌面端：左侧栏或顶部工具按钮。
- 移动端：底部或侧边菜单。

### 页面

新增：

- `/agents/market`
- `/agents/my`
- `/agents/:userAgentID`
- `/chat/:conversationID/agents/:userAgentID/config`

### 组件

- `AgentMarketGrid`
- `AgentTemplateCard`
- `AgentConfigForm`
- `ToolSelector`
- `ProviderConfigForm`
- `AgentApiTestButton`
- `SessionAgentConfigPanel`

## 后端落地阶段

### Phase 1: ChatBotHost 骨架

- 初始化 TypeScript 服务
- 配置加载
- Mongo 连接
- REST API 框架
- 和 IM 后端的 API client

### Phase 2: 模型广场和 Agent 绑定

- Agent 模板 CRUD
- 用户添加 Agent
- 创建 IM Agent 用户
- 建立好友关系
- 前端模型广场页面

### Phase 3: 单聊 Agent

- IM 消息事件转发
- ChatBotHost 接收事件
- LangChain `createAgent` 运行
- 流式 patch 回 IM
- run/tool 日志

### Phase 4: 会话级配置

- `AgentSessionConfig`
- 单聊/群聊独立配置
- API key secretRef
- 上游 API 测试

### Phase 5: 群聊多 Agent

- `@agent` 路由
- 群内多 Agent 配置
- Agent @ 用户和 Agent @ Agent
- 防循环策略：同一 run 最大 Agent hop 数

### Phase 6: 高风险 tools

- workspace_read/write
- bash sandbox
- approval workflow
- tool call UI 和审计查询

## 当前优先级

先做 Phase 1 到 Phase 3。不要一开始做 bash/write。先把“模型广场添加 Agent -> 好友列表出现 Agent -> 单聊流式回复”跑通，这是端到端主链路。

## 关键风险

- Agent 配置污染：必须按用户和会话隔离。
- 工具越权：所有 tool call 必须服务端鉴权。
- 群聊循环：Agent @ Agent 需要 hop limit 和 run graph。
- 成本失控：每个 run 要限制 maxIterations、timeout、token/cost budget。
- 密钥泄露：API key 不进 IM 消息、不进前端响应、不进 prompt。
- IM/ChatBotHost 数据不一致：用 `imAgentUserID` 做强绑定，并保留补偿任务。

## 参考资料

- LangChain JS Agents: https://docs.langchain.com/oss/javascript/langchain/agents
- LangChain JS Models / Tool Calling: https://docs.langchain.com/oss/javascript/langchain/models
- LangGraph Persistence: https://docs.langchain.com/oss/javascript/langgraph/persistence
- LangChain MCP Tools: https://docs.langchain.com/oss/javascript/deepagents/code/mcp-tools
