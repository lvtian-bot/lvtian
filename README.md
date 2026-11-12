# 绿天 (Lvtian)

基于 DeepSeek Harness 的个人 AI 代理（Personal AI Agent）系统：跨平台常驻服务端 + React Native 随身控制台。

手机端提供流式对话、工具审批、闪念速记与云协同；服务端作为代理中枢常驻运行在个人电脑或 VPS，基于 ACP 协议调度大模型工具链自主执行任务，手机离线断网不中断后台执行。

## 功能特性

- **自主执行与主聊天**：长连接流式输出，实时查看代理工具调用与执行进展，支持关键操作人工审批（Tool Approval），断线自动重连。
- **闪念速记**：时间线流式速记，一条灵感即时追加保存；内建三阶段自动同步算法，智能对账并解救冲突。
- **动态流**：服务端定时任务与异步代理执行动态的时间线呈现。
- **系统文件 / 在线网盘**：直连服务端宿主机真实目录，纯在线浏览、Markdown 预览与轻度在线编辑。
- **云协同**：支持 WebDAV 协议同步，云端为唯一真相来源，本地缓存仅作首屏加速。
- **任务中枢**：服务端驱动的独立任务体系与流转（开发中）。

## 技术栈

| 类别 | 技术 |
|------|------|
| 核心框架 | React Native 0.88.1 · Expo SDK 58 · React 19.3 |
| 语言 | TypeScript（严格模式） |
| 状态管理 | Zustand |
| 导航 | React Navigation 7 |
| 编辑器 | CodeMirror 6（WebView 托管，Vite 单文件打包） |
| 服务端 | Node.js ≥ 22.19 · DeepSeek Harness · ACP 协议 · WebSocket |

## 快速上手

### 1. 服务端配置与启动

服务端支持 Linux（VPS/个人电脑）与 Windows 常驻运行：

```bash
cd server
npm install

# 配置大模型 API Key（以 DeepSeek 为例）
export DEEPSEEK_API_KEY="your-deepseek-api-key"

# 编译并启动
npm run build
node dist/index.js
```

> **提示**：
> - 首次启动会自动在 `~/.config/lvtian/config.json` 生成服务配置，并生成唯一的安全访问令牌（Token）。
> - 随时可在 `server/` 目录下执行 `npm run token` 查看当前连接 Token。

### 2. 移动端运行与连接

```bash
# 根目录下安装依赖并启动
npx expo install
npx expo run:android    # 构建并部署到真机或模拟器（调试运行零外部凭据要求）
```

**连接配对**：
打开手机 App，在「我」/「设置」中输入你的服务端地址（如 `http://<服务器内网IP>:1999`）和服务端输出的 Token，即可完成连接。

## 服务端生产部署与公网安全

后台常驻守护支持脚本或 systemd：使用 `server/scripts/start.sh` 启停，或按 `server/scripts/lvtian-server@.service` 模板注册服务。

### 公网安全与 HTTPS / WSS 加密配置

> ⚠️ **安全警告**：若将服务端部署在公网 VPS 上，**切勿直接将未加密的 1999 端口暴露公网裸连**，以免访问令牌（Token）与私人对话在传输中被截获。强烈建议通过反向代理配置权威 SSL/TLS 证书。

- **推荐方案（域名 + 自动申请证书）**：
  在 VPS 前端部署 Caddy（或其他反向代理），Caddyfile 仅需 3 行即可实现全自动申请与续签免费 SSL 证书：
  ```caddyfile
  your-domain.com {
      reverse_proxy 127.0.0.1:1999
  }
  ```
  配置后，移动端服务地址直接填写 `https://your-domain.com` 即可，长连接（WSS）与 API 请求将自动获得 TLS 1.3 传输加密。

- **无独立域名方案（Tailscale 虚拟私网）**：
  若 VPS 仅有公网 IP 暂无独立域名，推荐手机与服务端共同加入 Tailscale，流量全程通过底层 WireGuard 强加密隧道直连，兼顾免公网暴露与安全保障。

## 常用命令

| 场景 | 命令 |
|------|------|
| 客户端检查 | `npx tsc --noEmit` · `npx eslint .` · `npx jest` |
| 服务端检查 | `cd server && npm run typecheck && npm test` |
| 编辑器/预览构建 | `npm run build:web` |
| 原生预构建 | `npx expo prebuild --clean` |

## 仓库结构

```text
├── App.tsx            # APP 入口
├── src/               # APP 源码（screens / services / store / navigation / editor-web...）
├── server/            # 独立服务端（源码 src/、守护脚本 scripts/、测试 test/）
├── plugins/           # Expo Config Plugins（原生行为定制）
├── assets/            # 图标与启动图
└── docs/              # 技术文档体系（入口：docs/技术架构.md）
```

## 常见问题

- **手机端提示“服务连接失败”？**
  1. 确认服务器端进程正在运行且端口开放；
  2. 优先验证手机与服务器之间的实际网络连通性（如果是局域网连接，确保手机与电脑在同一 Wi-Fi 网段；若是公网 VPS，确保防火墙放行对应端口）。
- **外部开发者如何打包独立发布？**
  项目默认使用 Expo 本地调试签名；如需构建正式 Release 安装包，请在 `app.config.js` 中配置你自己的 EAS 项目 ID 并注入个人的 Android 签名密钥。

## 详细文档

- **[docs/技术架构.md](docs/技术架构.md)**：系统技术架构、分层设计与模块文档索引（推荐先读）
- **[docs/产品/PRD.md](docs/产品/PRD.md)**：产品愿景、核心特性与演进规划
- **[docs/TODO.md](docs/TODO.md)**：开发待办与演进记录

## 开源协议

本项目基于 [MIT 许可证](LICENSE) 开源。
