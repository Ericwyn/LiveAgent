<p align="center">
  <img src="crates/agent-gui/src-tauri/icons/icon.png" width="128" height="128" alt="LiveAgent" />
</p>

<h1 align="center">LiveAgent</h1>

<p align="center">
  <strong>Your Local-First AI Agent Desktop</strong><br/>
  多模型接入 · 工具执行 · MCP 协议 · Skills 生态 · 远程 Gateway
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> •
  <a href="#核心能力">核心能力</a> •
  <a href="#架构">架构</a> •
  <a href="#部署">部署</a> •
  <a href="docs/">文档</a>
</p>

---

## 什么是 LiveAgent

LiveAgent 是一个 **本地优先** 的 AI Agent 桌面客户端。它将大语言模型的推理能力与本地系统工具深度整合，让 AI 能够真正操作你的文件系统、执行命令、管理定时任务，同时通过 Gateway 实现远程访问和协作。

> 桌面端是真相源 — 所有工具执行、持久化和秘钥都留在本地，Gateway 只做中继。

---

## 核心能力

| 能力 | 说明 |
|---|---|
| 🧠 多模型路由 | Claude (Anthropic)、Codex (OpenAI)，支持自定义 Base URL 和第三方兼容服务 |
| 🔧 内建工具集 | 文件读写、精确编辑、目录搜索、Bash 命令执行、HTTP 测试 |
| 🔌 MCP 协议桥接 | 通过 Tauri 端原生桥接 MCP Server，扩展无限工具能力 |
| 📦 Skills 系统 | 渐进式披露的技能包，按需加载，支持安装/创建/打包/ClawHub 生态 |
| 🧩 Sub-Agent 委派 | 独立子代理并行执行，worktree 隔离，自动合并 |
| 💾 持久化记忆 | Markdown + SQLite FTS 全文检索，跨会话持久知识管理 |
| ⏰ 定时任务 | 支持 bash / http / prompt 三种 Cron 任务 |
| 🌐 远程 Gateway | Go + gRPC 网关，浏览器 WebUI 远程操控本地 Agent |
| 🔄 历史压缩 | Segment + Summary Checkpoint，长对话不丢上下文 |
| 🌍 国际化 | 内建 i18n 多语言框架 |
| 🔒 本地优先 | API Key 不上传、工具不越权、Gateway 只中继不存密 |

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                        Browser WebUI                          │
│              React + Vite + WebSocket + Gateway API           │
└────────────────────────────┬─────────────────────────────────┘
                             │ WebSocket / HTTP
┌────────────────────────────▼─────────────────────────────────┐
│                       Agent Gateway                           │
│         Go · gRPC · HTTP · Session Manager · Event Store     │
│                    (Railway / Docker / 自部署)                 │
└────────────────────────────┬─────────────────────────────────┘
                             │ gRPC (双向流)
┌────────────────────────────▼─────────────────────────────────┐
│                        Agent GUI                              │
│                   Tauri 2 · React 19 · Rust                  │
├──────────┬───────────┬───────────┬───────────┬───────────────┤
│ 模型协议  │ Agent运行时 │  工具执行   │  Skills   │  Memory/Cron  │
│ pi-ai    │ 多轮循环   │ FS/Bash/  │  渐进披露  │  SQLite+MD    │
│ + Codex  │ + SubAgent │ MCP桥接   │  + Hub    │  FTS索引      │
└──────────┴───────────┴───────────┴───────────┴───────────────┘
```

---

## 技术栈

### Agent GUI — 桌面客户端

| 层 | 技术 |
|---|---|
| 框架 | Tauri 2 + React 19 + TypeScript 6 |
| 构建 | Vite 8 + pnpm |
| 样式 | Tailwind CSS 4 + Radix UI |
| 渲染 | streamdown + KaTeX + Mermaid + Monaco Editor |
| 后端 | Rust + Tokio + SQLite (rusqlite) + gRPC (tonic) |
| LLM | @earendil-works/pi-ai · @openai/codex-sdk · claude-agent-sdk |

### Agent Gateway — 远程网关

| 层 | 技术 |
|---|---|
| 语言 | Go 1.25 |
| 协议 | gRPC + Protobuf + HTTP + WebSocket |
| Web UI | React + Vite + Tailwind CSS (嵌入式) |
| 部署 | Docker multi-stage · Railway CI/CD |

---

## 项目结构

```
LiveAgent/
├── crates/
│   ├── agent-gui/                # 桌面客户端
│   │   ├── src/                  # React 前端
│   │   │   ├── components/       #   UI 组件
│   │   │   ├── lib/              #   核心逻辑 (chat, tools, skills, memory)
│   │   │   ├── pages/            #   页面 (Chat, Settings)
│   │   │   ├── i18n/             #   国际化
│   │   │   └── prompt/           #   System Prompt 模板
│   │   └── src-tauri/            # Rust 后端 (Tauri)
│   │
│   └── agent-gateway/            # Go 网关服务
│       ├── cmd/gateway/          #   入口
│       ├── internal/             #   核心实现
│       ├── proto/v1/             #   Protobuf 定义
│       └── web/                  #   嵌入式 WebUI
│
├── docs/                         # 项目文档
│   ├── architecture/             #   架构设计
│   ├── features/                 #   功能说明
│   └── operations/               #   运维部署
│
├── scripts/release/              # 发布自动化
├── .github/workflows/            # CI/CD (CI + Desktop Release + Gateway Docker)
├── Dockerfile                    # Gateway 容器镜像
├── Makefile                      # 构建命令集
└── Cargo.toml                    # Rust workspace
```

---

## 快速开始

### 环境要求

| 工具 | 版本 | 用途 |
|---|---|---|
| Node.js | >= 22 | 前端构建 |
| pnpm | >= 10 | 包管理 |
| Rust | stable | Tauri 桌面后端 |
| Go | >= 1.25 | Gateway（可选） |
| protoc | latest | gRPC 代码生成（可选） |

### 桌面客户端

```bash
# 安装依赖
pnpm --dir crates/agent-gui install

# 开发模式（热重载）
make dev

# 构建发行版
make build
```

### Gateway 服务（可选）

```bash
# 启动 Gateway 开发服务
make dev-gateway

# 启动 WebUI 开发服务
make dev-webui

# 构建 Docker 镜像并健康检查
make gateway-docker-smoke
```

---

## 内建工具

| 分类 | 工具 | 说明 |
|---|---|---|
| 文件系统 | `Read` `Write` `Edit` `Delete` | 文件读写与精确替换 |
| 搜索 | `List` `Glob` `Grep` | 目录遍历、模式匹配、正则搜索 |
| Shell | `Bash` | 非交互式命令执行，支持 cwd/timeout |
| 进程 | `ManagedProcess` | 长驻进程管理（dev server 等） |
| 网络 | `TunnelManager` | 本地服务一键暴露公网 |
| MCP | 动态工具桥接 | 通过 MCP 协议接入任意 stdio/http 工具 |
| 系统 | `CronTaskManager` | 定时任务 CRUD |
| 知识 | `MemoryManager` | 持久化记忆读写搜索 |
| Skills | `SkillsManager` | 技能包安装/创建/管理 |
| 委派 | `Agent` | Sub-Agent 并行任务委派 |

---

## 部署

### 桌面应用发布

通过 GitHub Actions 自动化，支持：
- **macOS**: Intel + Apple Silicon，签名 + 公证 + DMG
- **Windows**: NSIS 安装包
- **Linux**: AppImage / DEB / RPM

触发方式：推送 `v*` 标签或手动 dispatch。

### Gateway 部署

```bash
# Docker 构建（multi-stage，最终镜像 ~30MB）
docker build -t liveagent-gateway .

# 运行
docker run -p 8080:8080 -p 50051:50051 \
  -e LIVEAGENT_GATEWAY_TOKEN=your-token \
  liveagent-gateway
```

支持 Railway 一键部署（已配置 `railway.json`）。

---

## Make 命令速查

| 命令 | 说明 |
|---|---|
| `make dev` | 启动 Tauri 开发环境 |
| `make build` | 构建桌面应用 |
| `make dev-gateway` | 启动 Gateway 开发服务 |
| `make dev-webui` | 启动 WebUI 开发服务 |
| `make gateway-build` | 构建 Gateway 二进制 |
| `make gateway-docker-build` | 构建 Docker 镜像 |
| `make gateway-docker-smoke` | 构建 + 健康检查 |
| `make desktop-build-macos-release` | macOS 签名发布构建 |
| `make build-linux` | Linux amd64 网关 |
| `make build-linux-arm` | Linux arm64 网关 |
| `make proto` | 重新生成 Protobuf 代码 |
| `make clean` | 清理构建产物 |
| `make help` | 查看所有命令 |

---

## 文档

| 文档 | 说明 |
|---|---|
| [架构总览](docs/architecture/overview.md) | 系统分层、进程边界、数据流 |
| [GUI 架构](docs/architecture/gui.md) | 桌面客户端内部设计 |
| [Gateway 架构](docs/architecture/gateway.md) | 网关服务设计 |
| [Chat 运行时](docs/features/chat-runtime.md) | Agent 对话循环机制 |
| [工具系统](docs/features/tools.md) | 内建工具实现 |
| [Skills & MCP](docs/features/skills-and-mcp.md) | 技能与协议扩展 |
| [记忆系统](docs/features/memory.md) | 持久化记忆设计 |
| [部署运维](docs/operations/deployment.md) | Docker、自部署、桌面发布 |

---

## 设计原则

- **桌面端是真相源** — 工具执行、持久化、秘钥全部留在本地
- **Gateway 不越权** — 不访问文件系统、不存 API Key，只做中继
- **长对话可恢复** — Segment + Summary + SQLite Event Log
- **功能域清晰** — Chat / Tools / Memory / Skills / MCP / Cron 各自独立
- **渐进式复杂度** — Skills 按需加载，MCP 按需桥接，SubAgent 按需委派

---

## License

Private
