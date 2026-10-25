# 绿天 (Lvtian)

基于 DeepSeek Harness 的个人 AI 代理（Personal AI Agent）系统：跨平台常驻服务端 + React Native 随身控制台。安卓端提供流式交互、工具调用审批、闪念速记与云协同；服务端作为代理中枢常驻运行，基于 ACP 协议调度工具链自主执行任务。

## 功能特性

- **主聊天**：与服务端长连接，流式输出、工具活动展示、人工审批卡片，断线自动重连
- **闪念**：时间线速记，一条输入即时追加保存，三阶段同步自动检测并解救冲突
- **待办**：服务端驱动的独立待办体系（建设中，当前为就绪引导态）
- **动态**：服务端任务与执行动态的时间线呈现
- **系统文件 / 云盘**：直连服务端真实目录，纯在线浏览、预览与轻度编辑
- **笔记同步**：WebDAV 云端为唯一真相来源，本地缓存仅作首屏加速

## 技术栈

| 类别 | 技术 |
|------|------|
| 核心框架 | React Native 0.86.3 · Expo SDK 57 · React 19 |
| 语言 | TypeScript（严格模式） |
| 状态管理 | Zustand |
| 导航 | React Navigation 7 |
| 编辑器 | CodeMirror 6（WebView 托管，Vite 单文件打包） |
| 服务端 | Node.js ≥ 22.19 · TypeScript · WebSocket |

## 环境要求

- Node.js LTS v20+（服务端 ≥ 22.19）
- JDK 17（安卓构建）
- 安卓真机或模拟器

## 快速开始

```bash
# 安卓 APP
npx expo install        # 安装依赖
npx expo start          # 启动 Metro 开发服务
npx expo run:android    # 构建并部署到真机/模拟器

# 服务端
cd server
npm install
npm run dev             # 编译并启动
```

## 常用命令

| 场景 | 命令 |
|------|------|
| 类型检查 | `npx tsc --noEmit` |
| 代码检查 | `npx eslint .` |
| 单元测试 | `npx jest` |
| 编辑器/预览构建 | `npm run build:web` |
| OTA 热更新 | `npm run update:prod` / `npm run update:preview` |
| 原生预构建 | `npx expo prebuild --clean`（改 app.config.js 或插件后） |

## 服务端部署

服务端支持 Linux（VPS/个人电脑）与 Windows 常驻运行：

```bash
cd server
npm install
npm run build
node dist/index.js
```

后台守护：使用 `scripts/start.sh` / `stop.sh` 启停，或按 `scripts/lvtian-server@.service` 模板注册 systemd 服务。配置文件位于 `~/.config/lvtian/config.json`（首次启动自动生成，权限 0600）。

### 公网安全与 HTTPS / WSS 加密配置

> ⚠️ **安全警告**：若将服务端部署在公网 VPS 上，**切勿直接将未加密的 1999 端口暴露公网裸连**，以免访问令牌（Token）与私人对话在传输中被截获。强烈建议通过反向代理配置权威 SSL/TLS 证书。

- **推荐方案（域名 + 自动申请证书）**：
  在 VPS 前端部署 Caddy（或其他反向代理），Caddyfile 仅需 3 行即可实现全自动申请与续签免费 SSL 证书：
  ```caddyfile
  your-domain.com {
      reverse_proxy 127.0.0.1:1999
  }
  ```
  配置后，移动端服务地址直接填写 `https://your-domain.com` 即可。长连接（WSS）与 API 请求将自动获得最高级别的 TLS 1.3 传输加密，且无需手动输入端口号。

- **无独立域名方案（Tailscale 虚拟私网）**：
  若 VPS 仅有公网 IP 暂无独立域名，推荐手机与服务端共同加入 Tailscale，流量全程通过底层 WireGuard 强加密隧道直连，兼顾免公网暴露与银行级安全。

## 构建与发布

- **整包发版**：主分支递增版本号后打 `v*` tag 推送，GitHub Actions 云端自动构建 APK 并发布 Release；原生变更（依赖、包名、图标、版本号）必须走整包发版
- **OTA 热更新**：仅限 JS 层改动，纯 JS 的 PR 合并后自动推送，App 下次启动生效
- **签名**：沿用统一签名密钥，覆盖安装不影响本地数据

## 仓库结构

```text
├── App.tsx            # APP 入口
├── src/               # APP 源码（screens / services / store / navigation / editor-web / preview-web...）
├── server/            # 独立服务端（源码 src/、守护脚本 scripts/）
├── plugins/           # Expo Config Plugins（原生行为定制，严禁直改 android/）
├── assets/            # 图标与启动图
└── docs/              # 技术文档体系（入口：docs/技术架构.md）
```

## 常见问题

- **换了新图标，桌面没变？** 桌面图标属原生资源，热更新推不动；安装新版 APK 后生效。
- **热更新推送后手机收不到？** 热更新只送达与推送时版本号一致的安装包，旧版本包需升级最新 APK。
- **服务端连不上？** 先确认服务进程在跑、端口可访问，再从手机实际网络环境验证，不能只验证服务器本机。

## 文档

- **[docs/技术架构.md](docs/技术架构.md)**：系统技术架构、分层设计与模块文档入口（推荐先读）
- **[docs/产品/PRD.md](docs/产品/PRD.md)**：产品愿景、核心特性与演进规划
- **[docs/TODO.md](docs/TODO.md)**：开发待办与演进记录
