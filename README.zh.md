<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-pkg">
    <img src="public/favicon.svg" width="112" alt="DeepSeek Harness Pkg" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Pkg</h1>

<p align="center">
  <em><a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>（<code>dsh</code>）的跨平台生产依赖包 —— 固定版本、应用补丁，由 GitHub Actions 自动同步构建。</em>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/%40deepseek-ai%2Fdsh?style=flat-square&label=dsh" alt="dsh" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
  <img src="https://img.shields.io/badge/Node.js-22.19%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22.19+" />
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-pkg/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
</p>

> **开发者预览。** 上游迭代较快，可能出现不兼容变更。

## 快速开始

ZIP 包含 `dsh` CLI 与 Web UI 的生产 npm 依赖，不含 Node.js 可执行文件，也不是桌面安装包。

**要求：** 自行安装 Node.js `>=22.19.0` 并加入 `PATH`（CI 使用 `22.22.0`）；使用 ZIP 无需全局安装 pnpm。

从 [Releases](https://github.com/dsh-tauri/deepseek-harness-pkg/releases) 下载对应平台的 ZIP，解压后在解压根目录打开终端。

| 平台 | ZIP |

## 目录结构

```text
.
├── .github/workflows/
│   ├── release.yml                 # 基于 npm 的跨平台构建 + 发布
│   ├── release-from-source.yml     # GitHub-only 版本的源码构建 + pre-release
│   ├── sync-release.yml            # 定时检测 npm 版本并自动构建
│   └── sync-source-release.yml     # 定时检测 GitHub Release 并触发源码构建
├── scripts/
│   ├── apply-dsh-web-app-patch.mjs               # 幂等应用 LAN 开关补丁（上游 guard 变更时明确失败）
│   ├── apply-pi-ai-codex-error-patch.mjs         # 脱敏 Codex 上游 HTML 错误
│   ├── check-artifact-size.mjs                   # 报告发布产物体积（只报告、不拦截）
│   ├── check-dsh-installable.mjs                 # fan-out 前先解析完整依赖链，确认这一版发全了
│   ├── check-workflows.mjs                       # 本地自检 .github/workflows/*.yml
│   ├── selftest-check-workflows.mjs              # check-workflows.mjs 的反向测试（仅本地自检）
│   ├── delete-stale-drafts.mjs                   # 清理同版本残留的 draft release，保证重跑幂等
│   ├── prune-node-modules.mjs                    # 打包前瘦身 node_modules 并输出体积报告
│   ├── resolve-latest-dsh-version.mjs            # 取 npm 所有 dist-tag 中 semver 最高的已发布版本
│   ├── resolve-latest-github-release-version.mjs # 取上游 GitHub Release 中 semver 最高的版本
│   ├── wait-for-npm-version.mjs                  # 轮询 npm，等刚发布的版本 tarball 真正可下载
│   └── zip-footprint.mjs                         # 只读汇总 zip 的体积构成（不解压）
├── public/
│   └── favicon.svg                 # README 图标
├── pnpm-workspace.yaml             # nodeLinker/构建脚本策略等（pnpm 11 设置统一在此）
├── package.json                    # 固定 @deepseek-ai/dsh 版本
└── pnpm-lock.yaml                  # 锁文件
```

## 本地构建

要求：Node.js `>=22.19`（推荐 24）、pnpm `11.x`（仓库已声明 `packageManager: pnpm@11.7.0`）。

```sh
pnpm install            # 安装依赖；LAN 补丁仅在 CI 打包步骤显式应用
pnpm start              # 本地直接运行：dsh web（http://127.0.0.1:3080）
pnpm build              # 产出 prod 部署目录 build_dir/
```

## 发布

### 从私有二开仓库构建四个平台

在仓库 Settings → Secrets and variables → Actions 中添加 `HARNESS_SOURCE_TOKEN`。该 Token 只需对 `userAmani/deepseek-harness` 具有 Contents: Read 权限；建议使用 fine-grained personal access token，并仅授权这一个源码仓库。

打开 Actions，手动运行 **Build private Harness runtimes**，填写：

- `harness_repository`：默认 `userAmani/deepseek-harness`。
- `harness_ref`：要打包的分支、tag 或完整 commit SHA；正式包建议填写 commit SHA。
- `runtime_version`：例如 `0.1.2-enterprise.1`。
- `minimum_desktop_version`：默认 `0.6.8`。

工作流会在 Windows x64、macOS arm64、macOS x64 和 Linux x64 上构建同一个 Harness 提交，最后产生 `harness-server-upload-*` Artifact。下载并解压后，将其中内容原样上传到网站 `/harness/` 目录。项目不保存 OSS 凭据，也不会自动上传服务器。

运行包固定内置 `dsh-tauri@0.6.7`，构建时校验 npm tarball 的 SHA-512。桌面端会直接从运行包加载该基础消息桥，首次启动不再为它访问 npm 或 GitHub；其他社区插件仍由用户按需安装。

本地联调不要求先提交 Harness。三个仓库位于同一父目录时，可在本仓库运行：

```sh
pnpm run build:private-harness -- \
  --harness ../deepseek-harness \
  --output dist/private-runtime \
  --version 0.1.2-enterprise.1 \
  --node-version 22.22.0
```

此命令只构建当前平台；正式四平台包仍由 **Build private Harness runtimes** 完成。

最终必须能访问：

```text
https://toutiao.cdn.shuiwujia.com/harness/channels/stable/latest.json
```

每次更新 Harness 时使用新的 `runtime_version` 和 `build-id` 路径；先上传 `releases/`，最后覆盖 `channels/stable/latest.json`。

### 上游兼容发布（企业流程不使用）

进入仓库的 Actions 页面，手动触发 **Build and Release DeepSeek Harness**：

- `dsh_version`（必填）：要打包的 dsh 版本。Actions 表单会预填 `release.yml` 中声明的默认值；当前跟踪的版本以 `package.json` 中固定的 `@deepseek-ai/dsh` 为准。需要时可填写 `latest` 或其他明确版本。

构建完成后会自动创建形如 `dsh-<版本>-<run_id>` 的 GitHub Release，附四个平台的 zip：

| 平台 | 产物 || --- | --- |
| Windows | `deepseek-harness-pkg-windows.zip` |
| macOS（Apple Silicon） | `deepseek-harness-pkg-macos-arm64.zip` |
| macOS（Intel） | `deepseek-harness-pkg-macos-x64.zip` |
| Linux | `deepseek-harness-pkg-linux.zip` |

Windows（PowerShell）：

```powershell
.\node_modules\.bin\dsh.cmd web
```

macOS / Linux：

```sh
./node_modules/.bin/dsh web
```

默认地址为 `http://127.0.0.1:3080`，请遵循 CLI 输出的认证访问指引。在界面中配置模型提供方/API Key，详见[上游文档](https://github.com/deepseek-ai/deepseek-harness)。

## 本地构建

维护者需要 Node.js `>=22.19.0` 与 pnpm `11.7.0`，版本声明见 [package.json](<package.json>)。当前固定的 `@deepseek-ai/dsh` 版本为 `0.2.1-alpha.1`；桌面应用另按兼容规则选择内核。

```sh
pnpm install
pnpm start              # 使用仓库依赖运行 dsh web
pnpm build              # 将生产依赖部署到 build_dir/
```

`pnpm build` 部署到 `build_dir/` 后会应用下表中的两个运行时补丁；`pnpm start` 并不运行这份部署产物。依赖布局与安装脚本设置见[工作区/构建策略](<pnpm-workspace.yaml>)。

## 发布与同步

两条同步工作流均每 **6 小时**运行，也支持手动输入：可选 `version`（留空自动选择）与 `force`（默认 `false`，用于强制重建）。

| 工作流 | 输入 / 选择规则 | 结果 |
| --- | --- | --- |
| [release.yml](<.github/workflows/release.yml>) | 必填 `dsh_version`：npm 版本或 `latest`；表单默认 `0.1.2-rc.1`，不等于当前固定版本。 | 四个 ZIP；普通 Release `dsh-<version>-<run_id>`（`<version>` 使用输入原值）。 |
| [sync-release.yml](<.github/workflows/sync-release.yml>) | 取 npm 所有已发布版本中 semver 最高者，覆盖所有 dist-tag，不只看 `latest`。 | 调用 npm 发布工作流；仅在发布成功后更新 `main` 的清单与锁文件。 |
| [release-from-source.yml](<.github/workflows/release-from-source.yml>) | 必填 `dsh_version`，不带 `dsh-v`；克隆准确的 `dsh-v<version>` tag，构建并部署运行时依赖闭包。 | 四个 ZIP；预发布 `dsh-src-<version>-<run_id>`；不更新 `main`。 |
| [sync-source-release.yml](<.github/workflows/sync-source-release.yml>) | 选择高于 npm 最高版本的上游 GitHub Release 最高版本。 | 调用源码工作流；除非强制重建，否则跳过已有的源码预发布。 |

npm 预检先[等待真实 tarball 可下载](<scripts/wait-for-npm-version.mjs>)，最多 10 分钟。随后以 `pnpm install --ignore-scripts` [实际安装完整依赖闭包](<scripts/check-dsh-installable.mjs>)，有界重试通过后才启动四平台构建矩阵。

两条发布路径均会[裁剪产物](<scripts/prune-node-modules.mjs>)并确认四个 ZIP 资产已上传。[体积报告](<scripts/check-artifact-size.mjs>)仅供参考，不作为发布门槛。

## 运行时补丁

| 构建路径 | [LAN 开关](<scripts/apply-dsh-web-app-patch.mjs>) | [Codex HTML 诊断](<scripts/apply-pi-ai-codex-error-patch.mjs>) |
| --- | --- | --- |
| 本地 `pnpm build` | 应用 | 应用 |
| npm 发布 | 应用并验证 | 应用并验证 |
| 源码预发布 | 应用并验证 | 此工作流不应用 |

构建期 LAN 补丁保留 `--host 0.0.0.0` 的默认拦截，仅设置 `DSH_PKG_ALLOW_LAN=1` 才放行。它**不替代**上游认证或权限机制。

主动启用 LAN（Windows/PowerShell；将 `192.168.1.10` 换成本机局域网 IP）：

```powershell
$env:DSH_PKG_ALLOW_LAN = "1"
.\node_modules\.bin\dsh.cmd web --host 0.0.0.0 --trusted-host 192.168.1.10:3080
```

macOS / Linux（同样替换局域网 IP）：

```sh
DSH_PKG_ALLOW_LAN=1 ./node_modules/.bin/dsh web --host 0.0.0.0 --trusted-host 192.168.1.10:3080
```

`--trusted-host` 限制主机信任范围，不是认证机制。请妥善保管上游访问凭据，仅在可信网络启用 LAN。

Codex 补丁将 HTML 边缘/拦截页面替换为包含 HTTP 状态及可选脱敏 Ray ID 的有限诊断。正常 JSON/文本提供方错误保持不变；源码预发布不承诺此补丁。

## 安全与使用

- 仅供个人学习、研究与测试，请勿用于商业用途。
- `dsh` 可执行本地代码：请使用可信、隔离的环境，避免导入不可信配置或插件。
- LAN 暴露会增加风险；切勿向不可信网络开放服务或分享访问令牌。
- 开发者不对使用本项目造成的数据丢失或安全问题负责。

## 相关项目与致谢

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是上游 CLI/Web/插件项目；[DeepSeek Harness Desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) 将这些依赖包用于桌面应用。

感谢 [n8n-pkg](https://github.com/hairyf/n8n-pkg) 的打包模式、[pnpm](https://pnpm.io/) 的依赖/部署工具，以及 [GitHub Actions](https://github.com/features/actions) 的跨平台构建支持。
