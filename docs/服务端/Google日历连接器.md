# Google 日历连接器

本文描述仓库现有 GOG 版，不代表生产已启用。产品后续拟改接官方 MCP，见 [Google Workspace MCP 连接器方案](<Google Workspace MCP 连接器方案.md>)。

## 职责与边界

连接器让用户从绿天 App 为该服务器配置的 Google 账号授权、查看连接状态、重新授权或断开。它不管理日历同步规则，不创建定时任务，不把授权视为对任何自动写入行为的同意。

- **App**：从「我 → 连接器」打开系统浏览器，用户在 Google 官方页面完成同意。返回绿天后查询服务端的连接状态；打开浏览器或看到浏览器回跳都不等于已连接。
- **服务端**：发起并关联一次短期授权请求；收到 Google 回调后由 GOG 完成授权和只读日历验证。首版仅申请日历读取权限，不申请日历写入或其他 Google 服务权限。授权事务、连接状态和 Google 凭据都归服务端；App、Agent 对话、工作区和 Git 不保存 Google 令牌。
- **隔离**：配置新的 Google OAuth 客户端、专用 GOG 配置和凭据目录。不读取默认 GOG 配置、旧令牌或旧密钥环口令。连接器凭据也不得被绿天的网盘/系统文件接口读取。
- **断开**：停止使用这个连接并移除本机授权数据；与在 Google 账号安全设置中撤销第三方访问不是同一操作。断开不删除任何日历事件。

## 通信契约

| 请求 | 用途 |
| --- | --- |
| `GET /api/connectors/google-calendar` | 读取状态和已识别账号（如有）。 |
| `POST /api/connectors/google-calendar/connect` | 发起授权或重新授权，返回 Google 授权地址。 |
| `POST /api/connectors/google-calendar/disconnect` | 断开连接，返回更新后的状态。 |
| `GET /oauth/google-calendar/callback` | Google 浏览器回调。只允许处理一个有效的、尚未消费的授权事务；不返回令牌、凭据或日历内容。 |

前三个接口使用绿天已有的 HTTP Bearer 鉴权。授权必须使用 HTTPS；运营侧应确保反向代理、监控与访问日志不记录回调查询字符串。浏览器回调页只提示返回 App 查看状态。

状态：`unavailable`（未配置或不可用）、`disconnected`（未连接）、`authorizing`（正在授权）、`connected`（后台验证通过）、`needs_reauth`（需重新授权）、`verification_unavailable`（已有连接但暂时无法验证，仍可断开）。`connected` 不表示任何个人自动化已启用。

## 服务端开关与 Google 配置

默认关闭。首版后台仅支持可校验目录所有权和权限的 POSIX 服务端；移动端连接绿天也须使用 HTTPS/WSS。部署时需要单独准备 Google Cloud OAuth **Web 应用**客户端，启用 Calendar API，并登记与 `redirectUri` 完全一致的 `https://<域名>/oauth/google-calendar/callback`。GOG 发起授权前需要指定账号，因此首版每个绿天服务实例由运维配置一个允许授权的 Google 账号；Google 页面选择不同账号不会把连接切到其他人。

`LVTIAN_GOOGLE_CALENDAR_DIR` 指向已有的绝对路径私有目录（仅服务账号可访问，Linux 权限 `0700`），放在系统文件接口允许根目录和 Agent 工作区之外。目录内 `runtime.json` 仅服务账号可读（Linux 权限 `0600`），配置字段如下；这里只列字段，不提供或保存实值：

| 字段 | 用途 |
| --- | --- |
| `gogPath` | 已验证的 GOG CLI 可执行文件绝对路径。 |
| `account` | 此连接器允许授权的 Google 账号。 |
| `clientId`、`clientSecret` | 新建的 Google OAuth Web 客户端凭据；不使用旧客户端。 |
| `keyringPassword` | 此连接器独立的后台解锁口令；不继承默认 GOG 环境。 |
| `redirectUri` | Google Cloud 中登记的精确 HTTPS 回调地址。 |

生产回调由同机 HTTPS 反代转发，保留配置的 `Host`，覆盖 `X-Forwarded-Proto: https`；必须避免在访问日志和链路追踪中保留回调查询字符串。没有独立配置时不会自动改用系统上的默认 GOG 账号。

## 上线验收

1. 用独立 Google Cloud OAuth 客户端启用 Calendar API、配置精确的 HTTPS 回调；按实际受众和授权范围配置同意页面。不要把客户端密钥或后台解锁口令交给手机或写进工作区。
2. 在测试账号上从 App 开始授权；核对用户同意页面仅申请日历连接所需权限，拒绝或超时后可以重新连接。
3. 确认连接状态来自实际后台对 Google Calendar 的只读验证；验证服务端重启、手机退出和账号需要重新授权的场景。
4. 验证回调重放不会二次授权，未登录绿天不能发起或断开连接，凭据文件不能通过系统文件接口读取，断开后无后台访问。

本验收不包含企业微信同步或任何个人定时任务。
