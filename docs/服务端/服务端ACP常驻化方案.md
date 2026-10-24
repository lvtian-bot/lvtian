# 服务端 ACP 常驻化升级方案

状态：待评审（2026-10-24 完成两条路线的一手验证后成稿）。

## 1. 背景与目标

当前服务端通过 `dsh --profile headless` 驱动 AI 助理：每条聊天消息拉起一个一次性子进程，跑完即退。该模式存在两个结构性问题：

1. **每轮冷启动成本无界增长**：每次执行都需从磁盘装载会话日志恢复上下文，耗时随历史长度增加，是唯一随使用时间持续恶化的无界项（对标依据见 `docs/服务端/会话与上下文对标研究.md`）；
2. **运行中人工审批空转**：headless 为单轮非交互执行器，无法在任务运行中途向客户端转发审批请求，协议层预留的审批契约从未真正生效。

本次升级将 DSH 驱动方式改为**常驻长连接**，一次性达成三个目标：消除每轮恢复成本、落地运行中人工审批、审批与常驻共用同一协议面。

## 2. 路线验证结论

候选路线均为官方发布（非社区方案），验证于 2026-10-24 在本地 Windows 环境完成，版本统一锁定 0.2.1-rc.3：

| 验证项 | TS SDK 路线（`@deepseek-ai/dsh-sdk-client`） | ACP 路线（`dsh --profile acp` + Zed ACP SDK） |
| --- | --- | --- |
| 官方出处 | 官方仓库 `packages/sdk/client`，配套 Python/Rust 实现 | 官方仓库 `packages/acp`，与主包同步发版 |
| 常驻形态 | 客户端实例持有常驻子进程，跨 `run()` 复用 | 单连接多会话常驻，stdio JSON-RPC 双向通信 |
| 多轮记忆 | 文档确认（`resumeSession` 恢复历史） | **实测通过**（跨轮暗号记忆验证） |
| 流式事件 | 支持（通知订阅） | **实测通过**（`agent_message_chunk` / `agent_thought_chunk` / `usage_update`） |
| **运行中审批** | **不支持**：官方 README「Known Limitations」明确双向请求在协议两端均未实现，仅预留传输层 | **已实现**：`session/request_permission` 为标准协议面 |
| 会话管理 | `resumeSession` | `session/new` / `list` / `resume` / `close`，profile 自带持久化 |
| 取消 | 协议层支持 | `session/cancel` / `$/cancel_request` |

**实测记录（ACP 路线）**：

- 协议层：`dsh --profile acp` 子进程启动、`initialize` 握手（ACP v1）、`session/new` 建会话、`session/close` 关会话全部成功；
- 业务层：同一会话连续两轮真实模型对话，第二轮准确复述第一轮约定的暗号，确认常驻会话上下文保持；事件流形态与协议规范一致，`stopReason=end_turn` 结束语义正常。

**选型结论：ACP 路线。** 两条路线均为官方正式路径，但 SDK 路线缺失审批能力（官方明确为未实现的未来工作），无法一次达成全部目标；ACP 路线常驻、多轮、审批三项全备，且全部经实测确认。此前「SDK 为主线」的预排序基于「SDK 审批能力待验证」的假设，验证结果推翻该假设，排序反转。

## 3. 架构设计

### 3.1 组件与职责

- 新建 `AcpEngineManager`（`server/src/acpEngineManager.ts`），承接现有 `DshRunner` 的全部职责边界：驱动任务、转发事件、处理审批与取消。`DshRunner` 在切换完成后移除，不保留双路径。
- 客户端协议栈使用 Zed 官方 `@agentclientprotocol/sdk`（版本 1.4.0），不自研协议实现。
- 引擎子进程为 `dsh --profile acp`，沿用现有 `resolveDshInvocation` 的本地二进制定位策略。

### 3.2 生命周期

- **懒启动**：服务端启动不拉引擎；首个会话请求到达时 spawn 引擎子进程并完成 `initialize` 握手。此后子进程常驻，服务所有会话（单连接多会话，每会话独立）。
- **会话映射**：沿用现有 `SessionManager` 的 dsh 会话绑定（`getDshSessionId` / `setDshSessionId`，语义不变）；首轮 `session/new` 后持久化 ACP 会话 ID，后续轮次与重连后经 `session/resume` 续接。
- **崩溃恢复**：监听子进程退出。运行中会话的任务状态终态化为 `error`（复用现有重启修复语义）；下个请求到达时懒重启引擎并 `session/resume` 恢复各会话上下文。恢复失败的会话明确报错，不静默新建（与 headless 时代的续接失败语义对齐）。
- **优雅关停**：`server.stop()` 顺序执行各活跃会话 `session/close`（冲刷持久化）→ 关闭连接 → 按退出阶梯终止子进程。替换现有 `stopAll` 的 SIGINT/SIGKILL 兜底实现。

### 3.3 事件流映射

| ACP 事件 | 服务端动作 |
| --- | --- |
| `agent_message_chunk` | 追加 `SessionManager` 消息增量，广播 `event_chunk`（delta） |
| `agent_thought_chunk` | 更新任务状态为 `thinking` |
| `tool_call` / `tool_call_update` | 映射为现有 `ToolCallState`，广播工具进度 |
| `usage_update` | 记录用量统计（不广播，供日志） |
| `session/prompt` 返回 `stopReason` | 终态化任务状态（`end_turn` → `completed`；异常 → `error`） |

现有 headless 的 `final` 事件长文本校准逻辑不再需要：ACP 的 `agent_message_chunk` 流即已提交文本，无 8KiB 截断问题（实施时以回归用例确认）。

### 3.4 审批流（本次升级的第二个交付目标）

1. 引擎经 `session/request_permission` 发起审批请求（server → client 的 JSON-RPC 请求）；
2. 服务端将请求映射为现有 `approval_request` 广播（`approvalId`、工具名、参数摘要），任务状态置 `awaiting_approval`，同时挂起 JSON-RPC 应答；
3. 移动端 `approval_response` 应答后，服务端回传允许/拒绝至引擎，任务状态恢复 `processing` 或按引擎反馈终态化；
4. **超时与断线**：审批挂起超过阈值（默认 5 分钟，配置化）自动拒绝并终态化 `stopped`；引擎崩溃时未决审批随会话一起终态化，客户端重连对账（现有 `sync` 机制）拿到的状态一致。

哪些操作触发审批由 dsh 引擎侧权限策略配置决定，实施时与提示词注入一并验证（见第 7 节）。

### 3.5 提示词与人设注入

沿用现有机制：记忆上下文（SOUL / MEMORY / USER）拼装为系统指令，通过 `DSH_SYSTEM_PROMPT` / `DEEPSEEK_SYSTEM_PROMPT` 环境变量注入子进程，并以提示词前缀兜底。ACP profile 下环境变量注入是否生效为实施期第一验证点；不生效则统一走提示词前缀，行为无回退风险。

### 3.6 内存策略

维持现有结论（见 `docs/服务端/服务端架构与协议.md` 4.2）：消息全量驻留内存，追加式事件日志 + 快照轮换已解决写入放大与重启加载。引擎侧上下文增长由 dsh 自动压缩兜底（对标研究确认引擎内置，窗口 80% 阈值触发）。本方案不引入额外的窗口化机制，避免为不存在的问题增加复杂度。

## 4. 迁移与兼容

- **数据层零迁移**：`SessionManager` 追加日志、seq 对账、重启修复语义均不变；
- **客户端协议零改动**：WebSocket 报文（`chat` / `stop` / `sync` / `approval_response`）与广播类型保持原样，移动端无感升级；
- **dshSessionId 语义不变**：仅续接方式从 headless 的 `--session-id` 参数改为 `session/resume` 调用；旧会话数据中已持久化的 dsh 会话 ID 在 ACP 引擎侧不通用，首次升级后旧会话首轮自动新建（历史消息仍在服务端日志中完整可查，仅丢失跨升级轮次的引擎侧记忆）；
- **依赖变更**：`server/package.json` 新增 `@deepseek-ai/dsh-acp`、`@agentclientprotocol/sdk`，`@deepseek-ai/dsh` 与 ACP 包锁定同一版本。

## 5. 版本锁定策略

三个依赖均锁定精确版本（禁用 `^` 范围漂移）：

- `@deepseek-ai/dsh`：`0.2.1-rc.3`
- `@deepseek-ai/dsh-acp`：`0.2.1-rc.3`（注意其 npm `latest` 标签停留在 0.0.1-rc.1，须显式指定 next 通道版本）
- `@agentclientprotocol/sdk`：`1.4.0`

升级流程：官方正式版发布后，解锁 → 跑通服务端测试套件与审批/恢复回归 → 重新锁定。适配面收敛在 `AcpEngineManager` 单个模块内。

## 6. 风险与实施期验证点

| 风险 | 应对 |
| --- | --- |
| rc 版本接口变更 | 精确锁版本；协议核心面为标准 ACP v1（跨厂商开放协议），外围变更适配成本可控 |
| ACP 包 `latest` 标签滞后 | 依赖清单显式写 next 通道版本号，升级评审时人工核对 |
| dsh-acp 对 `mcpServers` 等字段要求比标准更严格（实测已发现） | 客户端调用统一经 Zed SDK 类型 + 实施回归覆盖 |
| 系统提示词环境变量在 ACP profile 下的生效性 | 实施首日验证，兜底方案为提示词前缀（行为等价） |
| 审批触发策略（哪些操作询问用户） | 实施期按引擎权限配置验证，默认从严（涉及写操作即询问） |
| 生产环境为 Linux（本地验证为 Windows） | 部署前在 VPS 预发验证一轮协议层与审批 |

## 7. 选型重评触发条件

本选型为可逆决策：引擎对接收敛在 `AcpEngineManager` 单模块，切换路线的代价是一次模块级重写，不涉及移动端与存储层。出现以下任一情形时重新评估：

1. 官方为 TS SDK 路线落地双向请求（运行中审批）且绿天验证可用；
2. 绿天待办等自有体系需要引擎原生展示能力（plans/todos 展示层）且 MCP 工具路径无法满足——注意 ACP 裁掉的仅是 DSH 的 agent 工作清单展示层，绿天待办为服务端自有数据体系，正确联动路径是服务端将待办库以 MCP 工具暴露给引擎（ACP 对 MCP 为一等支持），该路径不依赖引擎原生 todos；
3. ACP 官方包演进停滞或出现重大不兼容变更，而 SDK 路线已形成能力超集。

附注：绑定 DeepSeek 的深度由模型层与引擎层决定（两条路线相同：DSH 引擎＋DeepSeek 模型），接入协议层的选择不改变绑定关系；ACP 的可移植性价值在未来接入第二个兼容引擎时兑现，届时仅需替换引擎进程启动段。

## 8. 实施拆步

1. `AcpEngineManager` 骨架：引擎懒启动、握手、会话映射、优雅关停；
2. 事件流接线：ACP 事件 → `SessionManager` 增量 → WebSocket 广播；
3. 审批流：`request_permission` ↔ `approval_request` 双向打通，含超时与断线终态化；
4. 崩溃恢复：子进程退出监测、懒重启、`session/resume` 续接；
5. 移除 `DshRunner` 与 headless 调用路径，补齐服务端测试（含审批、恢复、关停回归）；
6. 文档同步：`docs/服务端/服务端架构与协议.md` 执行模型章节改写，本方案归档至 `docs/outdated/` 或并入架构文档。
