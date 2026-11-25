# Google Workspace MCP 连接器方案

**状态：研究稿，待实施。** 现行仓库实现仍是 [GOG 版 Google 日历连接器](Google日历连接器.md)。已核对仓库、Cloud 项目与官方资料；未启用服务、未创建 OAuth 客户端、未实测官方 MCP。

## 一、交付范围：四项同一版

一次开发、一轮联调、同一版交付 **Gmail、Google 日历、Drive、Tasks**，不以日历先上线、再为其余服务另立开发任务。手机从「我 → 连接器」选择要授权的 Google 服务，跳到系统浏览器授权，返回 App 查看各项状态；随后在主聊天使用已授权能力。共用 OAuth、凭据刷新、MCP 传输、工具权限、审批和故障处理；仅按产品分别配置范围、端点和工具。四项并行验证；局部故障可隔离，但不能把只有日历可用称作完成四项交付。

| 服务 | 同版验收的使用场景 | 一开始就核对的限制 |
| --- | --- | --- |
| Gmail | 搜索邮件、读会话、按要求建草稿 | 直发、标记、归档和附件按官方支持及授权审批逐项确认；建草稿不等于已发送。 |
| Google 日历 | 查询日程；确认后在测试日历创建和改期 | 全日、时区、分页和重复事件；涉及发邀请、改参与人、删除等操作单独评估，不以读权限推断写权限。 |
| Drive | 搜索、读取支持的文件内容；确认后在测试目录创建支持的文件 | 核对格式、大小、实际上传能力、文件权限及 `drive.file` 可见范围；不承诺完整网盘/备份替代。 |
| Tasks | 查看清单和待办；确认后新增及完成待办 | 实查官方工具及 schema，重点核对清单归属、完成状态和日期；未给日期的任务不自动补截止日。 |

这是同版验证范围，不保证官方 MCP 覆盖 GOG 的所有命令。若某项核心动作不被支持，标清结果和替代用户流程，提请确认是否调整这一版的交付条件，不静默降级或再走 GOG/REST。独立的企业微信同步、自动排程和日历浏览页不纳入本次。

## 二、政策与当前仓库

- [Google AI 工具附录](https://workspace.google.com/terms/ai-tools/) 要求由 AI Agent、AI Harness 或模型驱动的 Workspace 数据访问使用 Google MCP；[官方公告](https://workspaceupdates.googleblog.com/2026/11/mcp-servers-cli-standardized-usage-tiers-now-available.html) 的执行节点是 **2027-02-01**。不能把 GOG/REST 包一层供 Agent 访问来规避。非 AI 驱动的独立确定性集成不因此自动迁移。已登录的 `gcloud` 是项目管理入口，不是 Workspace CLI，也不是用户授权。
- `gcloud` 只读核实 `lvtian-366f9`（显示名 `lvtian`）处于 ACTIVE，旧凭据关联项目编号 `971506484727` 对应 `simplejournal`。当时只查了日历，绿天项目未列出已启用的 Calendar API/MCP；其余服务和写权限待确认。使用绿天自己的 Cloud 项目，不改 SimpleJournal。
- 复用现有 [App 连接页](../../src/screens/ConnectorsScreen.tsx)、[连接客户端](../../src/services/GoogleCalendarConnectorService.ts) 和 [HTTP 路由](../../server/src/googleCalendarHttp.ts) 的交互及鉴权边界，扩展为通用连接。现有 [服务端实现](../../server/src/googleCalendarConnector.ts) 依赖 GOG，仅用于日历授权和后台验证；[主聊天 ACP](../../server/src/acpEngineManager.ts) 当前新会话传空 MCP 配置，不能把现有连接状态当作四项工具已接入。
- 官方公告将四项都列为正式发布，但 [Calendar 配置页](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server) 仍列开发者预览前置条件。以实际目标项目和试点账号成功调用为准，不以公告、`tools/list` 或 OAuth 回跳替代验收。

## 三、共用设计

1. **Cloud 与 OAuth**：经确认后在 `lvtian-366f9` 一次核对并启用四项产品 API 及相应 MCP 服务。配置独立 OAuth Web 客户端并选择 **Use this client for an AI-powered agent**；登记绿天服务端精确 HTTPS 回调。首版一个部署实例中的一个绑定账号，受众、项目权限和审批按实际 OAuth 范围核查；Gmail/Drive 的高权限范围可能触发额外验证。比较个人模式和自定义方案；外部 Testing 模式下非基本身份范围的刷新令牌一般七天过期，不能作为长期部署方案。部署方一次配置，手机用户不填项目 ID、密钥或授权码。[官方配置指南](https://developers.google.com/workspace/guides/configure-mcp-servers)
2. **授权与连接状态**：共用 [OAuth Web 授权码流程](https://developers.google.com/identity/protocols/oauth2/web-server)，一次性短时 `state` 与 PKCE S256、校验 OIDC 声明签名/发行者/受众/有效期/nonce，以 `sub` 绑定账号；请求离线访问，核对实际授予范围。允许同次授权覆盖用户所选服务；少授某个范围只影响对应能力。采用按产品记账的工具权限和状态，升级写范围需用户同意，不默认把四项所有读写权限一起索要。共用 OAuth 时 Google 端撤销可能影响同一授权下其他产品；必须向用户区分单项停用和整个 Google 账号授权撤销，不假设 Google 支持仅撤销某一项。刷新单飞且原子更新；区分撤销、权限不足、暂时不可用和限流。凭据仅在服务端私有加密存储，隔离 App、模型、工具进程、工作区、备份和文件接口，代理与应用日志不存授权查询字符串。
3. **产品适配与 ACP**：服务端以 Streamable HTTP 调用固定 Google 端点 `gmailmcp.googleapis.com`、`calendarmcp.googleapis.com`、`drivemcp.googleapis.com`、`tasksmcp.googleapis.com` 的 `/mcp/v1`，优先选成熟 MCP SDK。用 `tools/list` 核对工具/schema，再做真实 `tools/call`。为主聊天注册受限工具桥，可参考 [现有工具桥挂载机制](../../server/src/nativeTaskRuntime.ts)，不接入调度器；每次调用校验授权归属、端点、工具及参数白名单。写操作由绿天绑定确认内容与执行参数；Google 端如要求确认但客户端不能呈现，则停止，不跳过。写入超时不盲目重试，先读回核实。参考 [Gmail](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)、[日历](https://developers.google.com/workspace/calendar/api/v3/reference/mcp)、[Drive](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server) 官方说明；Tasks 以配置指南及真实工具发现为准。
4. **内容保护与生命周期**：按 [官方安全指南](https://developers.google.com/workspace/guides/configure-mcp-security) 筛查提示和工具返回，外部邮件、事件、附件、文件等当不可信数据；回传模型只给任务所需字段。不记录完整请求响应，不把 Workspace 数据写入长期记忆、索引、调试附件等。使用真实数据前验证模型供应商数据用途、禁训练和留存边界，并排查 ACP 会话、聊天记录、结果、导出和备份是否自动落盘工具原文或含 Workspace 数据的回复。断开或撤销后停止访问、废弃在途结果、清除应清数据与令牌；不能证明留存控制时不上真实数据。附录的 30 天上限指其定义的 Google Technical Information，不是用户数据通用保留期。保留最小脱敏诊断；标准层级每项目每产品每天最多 5,000 个请求，另有速率限制，按服务做节流与探测缓存，不默认升级付费层级。[配额说明](https://developers.google.com/workspace/guides/quota-usage-tiers)

## 四、同一轮实施和验收

| 工作 | 通过条件 |
| --- | --- |
| 联调前置检查 | 同轮用受控账号发现四套官方工具并验证最小权限。记录四项的权限、官方能力及实测差异；从任何一个服务取得的握手结果只用于验证共用传输，不作为其他三项开工门槛。 |
| 共用连接能力 | 手机能授权所选服务并看到各自状态；授权拒绝、错账号、回调重放、部分授权、服务端重启与刷新、重新授权、单项停用以及整体断开均经过测试。断开后不再调用；凭据和工具正文不进入日志、工作区、导出或未经允许的留存。 |
| 四项产品验收 | 同一版在真实主聊天中完成上表场景；写入只用隔离测试数据，有确认、有结果读回。验证权限不足、限流和内容注入，单项故障不影响其他已连接项。任何核心场景失败列为交付缺口，不把日历通过视为四项通过。 |
| 切换 | 按四项验收结果切换 Agent 入口，独立 GOG 令牌不迁移、现有个人 GOG 授权不撤销；出问题关闭受影响的能力或回滚功能开关，不回退至 GOG/REST 为 Agent 访问。SimpleJournal、企业微信同步和定时任务不改。 |
