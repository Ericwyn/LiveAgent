# CI/CD 与发布

本文档描述当前自动化发布链路：CI 检查、Gateway Docker 镜像、Railway 部署、桌面端 macOS/Windows Release。

## 自动化入口

| 入口 | Workflow | 动作 |
|---|---|---|
| PR / `main` push | `.github/workflows/ci.yml` | 跑 Gateway、WebUI、GUI、Tauri Rust 测试和 proto 一致性检查。 |
| `main` push 且 CI 成功 | `.github/workflows/gateway-docker.yml` | 构建并推送 `ghcr.io/<owner>/liveagent-gateway:main` 与 `sha-*` 镜像，然后部署 Railway。 |
| `v*` tag | `.github/workflows/gateway-docker.yml` | 构建并推送 `vX.Y.Z` 与 `latest` Gateway 镜像。 |
| `v*` tag | `.github/workflows/desktop-release.yml` | 并行构建 macOS Intel、macOS Apple Silicon 和 Windows x64 桌面包，并上传到 GitHub Release。 |

## Gateway 镜像

根目录 `Dockerfile` 是 Gateway 的生产镜像：

| 阶段 | 内容 |
|---|---|
| `webui` | 用 Node 22 和 pnpm 构建 `crates/agent-gateway/web/dist`。 |
| `gateway-builder` | 用 Go 编译 `cmd/gateway`，WebUI 静态资源通过 `go:embed` 打进二进制。 |
| `runtime` | Debian slim + CA certificates + `liveagent-gateway`，非 root 用户运行。 |

运行时变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `LIVEAGENT_GATEWAY_TOKEN` | 是 | WebUI、HTTP API、桌面 gRPC 的共享访问 token。 |
| `PORT` | Railway 自动提供 | HTTP/WebUI 监听端口，未提供时 Dockerfile 默认 `8080`。 |
| `LIVEAGENT_GATEWAY_GRPC_ADDR` | 否 | gRPC 监听地址，默认 `:50051`。 |

本地 smoke run 示例：

```bash
make gateway-docker-smoke
```

CI 中的 `Gateway Docker Smoke` job 会执行同等检查：构建镜像、启动容器、访问 `/healthz`。

## Railway

`railway.json` 使用根目录 `Dockerfile`，健康检查走公开 `/healthz`。`main` 分支 CI 通过后，`gateway-docker.yml` 会自动运行 `railway up --ci --detach` 部署同一份代码。

推荐生产部署模型：

| 流量 | Railway 能力 | Remote 配置 |
|---|---|---|
| WebUI / HTTP / WebSocket | Public Networking HTTPS 域名 | `Gateway URL=https://<service>.up.railway.app` |
| 桌面端 gRPC | TCP Proxy | `gRPC Endpoint=http://<tcp-proxy-host>:<tcp-proxy-port>` |

Gateway WebUI 和桌面 gRPC 地址分开后，Railway 的 HTTPS 域名和 TCP Proxy 地址可以独立配置。

Railway 自动部署需要这些 GitHub 配置：

| 名称 | 类型 | 说明 |
|---|---|---|
| `RAILWAY_TOKEN` | Secret | Railway project token，授予 CI 部署权限。 |
| `LIVEAGENT_GATEWAY_TOKEN` | Secret | Gateway 共享访问 token；部署 workflow 会自动写入 Railway service variable。 |
| `RAILWAY_SERVICE` | Variable | Railway service 名称或 ID；project token 只绑定单服务时可留空。 |
| `RAILWAY_ENVIRONMENT` | Variable | Railway environment 名称或 ID；project token 只绑定单环境时可留空。 |

Gateway 运行时变量会由 deploy workflow 自动写入或保留在 Railway service variables 中：

| 变量 | 说明 |
|---|---|
| `LIVEAGENT_GATEWAY_TOKEN` | WebUI、HTTP API、桌面 gRPC 的共享访问 token。 |
| `LIVEAGENT_GATEWAY_GRPC_ADDR` | 保持 `:50051`，供 Railway TCP Proxy 转发。 |

## GitHub Secrets

macOS signed/notarized release 需要这些 secrets：

| Secret | 说明 |
|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | Developer ID Application `.p12` 的 base64。 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码。 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: wenlin fei (UU94JSVAA9)`。 |
| `APPLE_ID` | Apple Developer 账号邮箱。 |
| `APPLE_TEAM_ID` | `UU94JSVAA9`。 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password。 |

脚本化写入：

```bash
RAILWAY_TOKEN=<railway-project-token> \
RAILWAY_SERVICE=<railway-service> \
RAILWAY_ENVIRONMENT=<railway-environment> \
  scripts/release/bootstrap-github-secrets.sh
```

如果 `/Users/houhaixu/Personal/cert/developer_id_application.p12` 不存在，脚本会从本机 Keychain 中的 `Developer ID Application: wenlin fei (UU94JSVAA9)` 自动导出，并生成 `.p12` 密码写入 GitHub Secret。已有 `.p12` 时需要传入 `APPLE_CERTIFICATE_PASSWORD=<p12-password>`。

脚本默认读取：

| 文件 | 用途 |
|---|---|
| `/Users/houhaixu/Personal/cert/developer_id_application.p12` | CI 导入的签名 identity。 |
| `/Users/houhaixu/Personal/cert/app key.md` | Apple app-specific password。 |

如果同时传入 `RAILWAY_TOKEN`、`RAILWAY_SERVICE`、`RAILWAY_ENVIRONMENT`，脚本也会写入 Railway 自动部署所需的 secret/variables。

## 桌面产物

`desktop-release.yml` 产物：

| 平台 | Runner | 产物 |
|---|---|---|
| macOS Intel | `macos-13` | `LiveAgent_<tag>_x64.dmg`，Developer ID 签名、公证、staple。 |
| macOS Apple Silicon | `macos-14` | `LiveAgent_<tag>_aarch64.dmg`，Developer ID 签名、公证、staple。 |
| Windows x64 | `windows-latest` | Tauri 生成的 `.msi` 和 NSIS `.exe`。 |

Windows 当前没有代码签名 secret，release workflow 会先自动发布 unsigned 包。接入 Windows `.p12/.pfx` 或 Trusted Signing 后再补签名步骤。
