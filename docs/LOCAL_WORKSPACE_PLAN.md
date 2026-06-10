# 本地工作区（Local Workspace / Manual Mode）实现方案

## 1. 架构概览

两种工作区模式对照：

```
┌─ auto 模式（已实现）────────────┐    ┌─ manual 模式（本文档）──────┐
│                                 │    │                            │
│  ChatBotHost                    │    │  Electron Client           │
│  ┌─────────────────────────┐    │    │  ┌──────────────────────┐  │
│  │ ws_{uuid}/  (本地沙盒)   │    │    │  │ /Users/xxx/project   │  │
│  │ 读写/执行都由 server 完成 │    │    │  │ 真实本地文件系统     │  │
│  └─────────────────────────┘    │    │  └─────────┬────────────┘  │
│                                 │    │            │ WS            │
└─────────────────────────────────┘    │  ChatBotHost              │
                                       │  ┌────────────────────┐  │
                                       │  │ workspace-proxy.js │  │
                                       │  │ 转发 I/O 到 client │  │
                                       │  └────────────────────┘  │
                                       └──────────────────────────┘
```

---

## 2. 参与方及职责

### 2.1 Electron 本地客户端

| 职责 | 说明 |
|------|------|
| **向 ChatBotHost 建立 WebSocket** | 连接后发送注册帧，携带用户 ID、可用路径等 |
| **响应文件操作指令** | 接收 `read_file`、`write_file`、`list_dir` 等消息，操作本地文件系统，返回结果 |
| **响应命令执行指令** | 接收 `exec` 消息，在本地 cwd 中 spawn 子进程，返回 stdout/stderr/exitCode |
| **心跳保活** | 定期发送 `ping`，ChatBotHost 超时未收到则标记离线 |
| **提供本地端口（备选）** | 也可以选择暴露 HTTP 端口供 ChatBotHost 调用，但 WS 复用更简单 |

### 2.2 ChatBotHost 后端

| 职责 | 说明 |
|------|------|
| **管理客户端连接表** | `Map<userID, { ws, activePath, connectedAt, lastHeartbeat }>` |
| **模式判定** | 有活跃本地客户端 → `manual`；否则 → `auto` |
| **代理工作区 I/O** | 新增 `local-workspace-proxy.js`，当 workpace 绑定了本地路径时，文件/命令操作通过 WS 转发 |
| **适配现有工具链路** | `tools.js` 中 `workspaceRead`/`workspaceWrite`/`bash` 不直接走 `node:fs`，改为调用 proxy |

### 2.3 前端（大部分已完成）

| 职责 | 说明 |
|------|------|
| 查询 mode | 已实现 `GET /workspace-mode` |
| 双模式 UI | 已实现 `WorkspacePanel.vue`、`ChatArea.vue`、`contacts/index.vue` |
| 待修改：FolderPickerModal | 手动模式下不应浏览 ChatBotHost 的文件系统，应改为让本地客户端提供目录列表（或客户端直接弹出原生选择器） |

---

## 3. WebSocket 协议设计

Electron 客户端连接 ChatBotHost WS（复用现有 WS 端口或新开端口）。消息格式：

```json
{ "type": "TYPE", "payload": { ... }, "requestID": "uuid" }
```

### 3.1 客户端 → ChatBotHost

| type | payload | 说明 |
|------|---------|------|
| `register` | `{ userID, workspacePath }` | 注册本地客户端 |
| `pong` | `{}` | 心跳响应 |
| `file_result` | `{ requestID, ok, path, content?, bytes?, error? }` | 文件操作结果 |
| `exec_result` | `{ requestID, ok, exitCode, stdout, stderr, durationMs }` | 命令执行结果 |
| `dir_result` | `{ requestID, ok, directories[], error? }` | 目录列表结果 |

### 3.2 ChatBotHost → 客户端

| type | payload | 说明 |
|------|---------|------|
| `ping` | `{}` | 心跳请求 |
| `read_file` | `{ requestID, path, maxChars }` | 读取文件 |
| `write_file` | `{ requestID, path, content }` | 写入文件 |
| `list_dir` | `{ requestID, path }` | 列出目录 |
| `exec` | `{ requestID, command, cwd, timeoutMs }` | 执行命令 |

---

## 4. 各模块实现清单

### 4.1 Electron 客户端（新项目）

需要实现的核心能力（伪代码）：

```
// 1. 连接 ChatBotHost WS
const ws = new WebSocket(`${CHATBOT_HOST_WS_URL}?type=local_client&userID=${userID}`)

// 2. 注册
ws.send(JSON.stringify({
  type: 'register',
  payload: {
    userID,
    workspacePath: '/Users/xxx/project'   // 用户选择的本地目录
  }
}))

// 3. 处理指令
ws.onmessage = async (msg) => {
  const { type, requestID, payload } = JSON.parse(msg.data)
  switch (type) {
    case 'read_file':
      // fs.readFile(resolve(workspacePath, payload.path), 'utf8')
      // ws.send({ type: 'file_result', requestID, ... })
      break
    case 'write_file':
      // fs.writeFile(resolve(workspacePath, payload.path), payload.content)
      break
    case 'list_dir':
      // fs.readdir(resolve(workspacePath, payload.path))
      break
    case 'exec':
      // child_process.spawn(payload.command, { cwd, shell: true })
      break
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }))
      break
  }
}
```

安全约束（与 ChatBotHost 现有 `resolveWorkspacePath` 对等）：
- 所有路径操作必须 `resolve(workspacePath, payload.path)`，禁止 `../` 逃逸
- 命令执行限制 cwd 在 workspacePath 内
- 禁止执行危险命令（可复用 ChatBotHost 的 `looksMutatingShellCommand`）

目录选择：Electron 端用 `dialog.showOpenDialog` 原生弹窗选择文件夹，选择后通过 `register` 帧上报路径。Frontend 端不必再通过 FolderPickerModal 浏览。

### 4.2 ChatBotHost 新增文件

#### `src/local-workspace-proxy.js`

```
localClients: Map<string, LocalClientInfo>

registerClient({ userID, ws, workspacePath })
  → 存入 localClients，标记 mode 为 manual

unregisterClient(userID)
  → 删除记录

getClient(userID): LocalClientInfo | null

proxyReadFile(userID, path, maxChars): Promise<Result>
  → 向客户端 WS 发送 read_file，等待 file_result

proxyWriteFile(userID, path, content): Promise<Result>
  → 向客户端 WS 发送 write_file，等待 file_result

proxyListDir(userID, path): Promise<Result>
  → 向客户端 WS 发送 list_dir，等待 dir_result

proxyExec(userID, command, cwd, timeoutMs): Promise<Result>
  → 向客户端 WS 发送 exec，等待 exec_result（带超时）

startHeartbeat(userID, intervalMs = 15000)
  → 定时 ping，超时无 pong 则认为离线，自动 unregister
```

核心逻辑：发送指令 → 等待对应 `requestID` 的响应（Promise + 超时 30s）。

### 4.3 ChatBotHost 修改现有文件

#### `src/index.js`

- 新增 WS 服务（或复用现有 HTTP server 的 `upgrade` 事件）监听本地客户端连接
- WS 路由：`/?type=local_client&userID=xxx`
- `on('message')` 分发 `register` / `pong` / `*_result` 到 proxy 模块
- `on('close')` 调用 `unregisterClient`
- `GET /workspace-mode` 响应改为动态判定：有活跃客户端 → `manual`，否则 `auto`

#### `src/tools.js`

修改 `workspaceRead` / `workspaceWrite` / `bash` 工具实现（或在这些函数内部调用前判断）：

```
if (context.useLocalClient && context.localClientUserID) {
  return proxyReadFile(context.localClientUserID, path, maxChars)
}
// 原有逻辑：直接 node:fs 操作沙盒
```

需要在 context 中增加两个字段：
- `useLocalClient: boolean` — 由 `resolveEventWorkspace` 填充
- `localClientUserID: string` — 指向哪个用户的客户端

#### `src/workspace-manager.js`

- `resolveEventWorkspace` 中，当 mode 为 `manual` 时，非 autoCreate 但 workspace 已绑定 local targetPath，则返回的 context 中标记 `useLocalClient: true`
- `createEmptyWorkspace` 在 manual 模式下不受影响（手动模式用户会通过客户端提供 targetPath）
- 新增 `createLocalWorkspace`（可选，也可复用现有 `createWorkspace` — 已有 targetPath 即走种子复制逻辑，但本地模式下不复制沙盒）

#### `src/agent-reply.js`

- `runMockAgentReply` 中 `resolveEventWorkspace` 返回的 context 已包含 `useLocalClient` 标记，透传给 tool executor 即可

### 4.4 前端修改

#### `app/components/workspace/FolderPickerModal.vue`

当 `workspaceMode === 'manual'` 时，不需要 ChatBotHost 端文件浏览器。两种方案：

- **方案 A（推荐）**：手动模式下不弹出 FolderPickerModal，改为提示"请在本地客户端选择工作区文件夹"。Electron 客户端自行用原生 dialog 选择路径后注册。
- **方案 B**：ChatBotHost 新增 `GET /local-client/:userID/directories`，proxy 到客户端取目录列表。前端 FolderPickerModal 通过此接口浏览本地文件。

推荐方案 A，更简单，且安全（用户本地文件夹不向 ChatBotHost 暴露完整目录结构）。

#### 其余前端文件

不需要改动。`WorkspacePanel.vue`、`ChatArea.vue`、`contacts/index.vue` 的双模式分支已完成。

---

## 5. 数据流对比

### auto 模式（已实现）

```
Agent → workspaceRead(path)
  → tools.js: requireBoundWorkspace(context)
  → resolve(context.workspacePath)   // ChatBotHost/workspaces/ws_xxx/
  → node:fs.readFile(sandboxPath)
```

### manual 模式（本文档实现）

```
Agent → workspaceRead(path)
  → tools.js: requireBoundWorkspace(context)
  → 检测 context.useLocalClient === true
  → proxy module: proxyReadFile(userID, path)
  → WS → Electron Client
  → Electron: fs.readFile(workspacePath + '/' + path)
  → WS response → proxy → tools.js 返回结果
```

---

## 6. 实施步骤（推荐顺序）

| 步骤 | 内容 | 预估工作量 |
|------|------|-----------|
| 1 | `local-workspace-proxy.js` — 连接管理、心跳、Promise 桥 | 中 |
| 2 | `index.js` — 新增 WS upgrade 处理 + `GET /workspace-mode` 动态判定 | 小 |
| 3 | `tools.js` — 在 `workspaceRead/Write/bash` 中增加 proxy 分支 | 小 |
| 4 | `workspace-manager.js` — `resolveEventWorkspace` 返回 `useLocalClient` 标记 | 小 |
| 5 | Electron 客户端 — WS 连接、注册、文件操作、命令执行 | 大 |
| 6 | 前端 FolderPickerModal — 手动模式下的交互调整 | 小 |
| 7 | 联调测试 | 中 |

---

## 7. 安全注意事项

- Electron 客户端必须校验路径不逃逸 `workspacePath`（与 server 端 `resolveWorkspacePath` 对称）
- `exec` 操作仅允许在白名单目录内执行
- WS 连接应做基本鉴权（可复用 IM 的 token 机制）
- 客户端断开后 ChatBotHost 自动回退到 auto 模式，不丢数据
