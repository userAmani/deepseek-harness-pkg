#!/usr/bin/env node
// 等待 npm 上某个版本**真的能下载**，再让 build 矩阵 fan-out。
//
// 背景：run 35694751348 —— 上游 06:23:31Z 发布 @deepseek-ai/dsh@0.1.7-alpha.1，
// sync job 06:25:34Z 就把它解析成目标版本并开跑，06:25:55Z 在 `pnpm add` 阶段
// 拿到 tarball 404（ERR_PNPM_FETCH_404
// GET https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-alpha.1.tgz），
// 四个平台的 build 一起失败。事后同一个 URL 已经 200，npm packument 的
// time.modified 也停在发布那一刻（说明并没有重新发布）—— 典型的发布传播窗口：
// **packument（版本列表 / dist.tarball）先可见，tarball 后可见**。
//
// scripts/resolve-latest-dsh-version.mjs 读的正是 packument，所以它会拿到一个
// 还没传播完的版本号。与其让 4 个 runner 各自撞一次 404、烧掉整轮构建，不如在
// fan-out 之前先在这里有界轮询：tarball 返回 200 才继续；等不到就明确失败，
// 下一个定时 sync 会因为「上一轮没有产生 release」而自然重试。
// 反向的滞后也存在（packument 慢、tarball 快），所以这里探的是 tarball 本身，
// 而不是 sleep 一个猜出来的固定时长。
//
// 用法:
//   node scripts/wait-for-npm-version.mjs --version=0.1.7-alpha.1
//   node scripts/wait-for-npm-version.mjs --package=@deepseek-ai/dsh --version=alpha
//     --timeout-seconds=600 --interval-seconds=15
//
// 退出码: 0 = 可下载；1 = 参数错误或超时未就绪。
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const label = '[wait-npm-version]'
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// npm 包名/版本/dist-tag 只允许这些字符。除了拦住手滑，也让 Windows 分支把
// spec 直接拼进 shell 命令行时不可能带出转义/注入问题。
const SAFE_SPEC = /^[A-Za-z0-9@._/+:-]+$/

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 版本还没进 packument 时 `npm view` 直接失败（非零退出），视作「未就绪」而不是错误。
// 走 npm 而不是裸 fetch registry，是为了尊重调用方的 .npmrc / registry 配置。
function resolveTarball(spec) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  try {
    const out = (
      process.platform === 'win32'
        // Windows 上 npm 是 npm.cmd，而 Node 自 CVE-2024-27980 起拒绝直接 spawn
        // .cmd（EINVAL: spawnSync npm.cmd EINVAL），必须经 shell。这里用单字符串
        // 形式而不是 { shell: true } + args 数组，是为了避开 DEP0190 警告；
        // spec 已由 SAFE_SPEC 校验过。Linux/macOS 分支不走 shell。
        ? execFileSync(`${npmCmd} view ${spec} dist.tarball --json`, { ...options, shell: true })
        : execFileSync(npmCmd, ['view', spec, 'dist.tarball', '--json'], options)
    ).trim()
    const url = out ? JSON.parse(out) : ''
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null
  } catch {
    return null
  }
}

// HEAD 够用且不下载内容；个别 registry/CDN 不支持 HEAD（返回 405/403）时退回
// Range 探测，确保探的是同一份 tarball 而不是只探到元数据。
async function probe(url) {
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (head.status !== 405 && head.status !== 403) return head.status
  } catch (err) {
    return `请求失败: ${err.message}`
  }
  try {
    const ranged = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' })
    return ranged.status
  } catch (err) {
    return `请求失败: ${err.message}`
  }
}

// 不用 process.exit()：Windows 上在子进程/undici 句柄还没关干净时强退会踩
// libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), win\async.c），
// 退出码变成 0xC0000409，CI 里看起来就像脚本自己崩了。改成设置 exitCode 后自然结束。
async function main() {
  const pkg = argValue('package', '@deepseek-ai/dsh')
  const version = argValue('version', '')
  const timeoutSeconds = Number(argValue('timeout-seconds', '600'))
  const intervalSeconds = Number(argValue('interval-seconds', '15'))

  if (!version) {
    console.error(`${label} 必须提供 --version=<版本或 dist-tag>，例如 --version=0.1.7-alpha.1`)
    return 1
  }
  for (const [name, value] of [
    ['--package', pkg],
    ['--version', version],
  ]) {
    if (!SAFE_SPEC.test(value)) {
      console.error(
        `${label} ${name} 含非法字符（只允许 npm 包名/版本/tag 允许的字符）：${JSON.stringify(value)}`,
      )
      return 1
    }
  }
  for (const [name, value] of [
    ['--timeout-seconds', timeoutSeconds],
    ['--interval-seconds', intervalSeconds],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`${label} ${name} 必须是正数`)
      return 1
    }
  }

  const spec = `${pkg}@${version}`
  const deadline = Date.now() + timeoutSeconds * 1000
  let attempt = 0
  let lastReason = '未知'

  // 先探一次再睡：健康时（绝大多数情况）这里零等待通过。
  while (true) {
    attempt += 1
    const tarball = resolveTarball(spec)
    if (!tarball) {
      lastReason = `npm view ${spec} 还没有 dist.tarball（packument 尚未可见）`
    } else {
      const status = await probe(tarball)
      if (status === 200 || status === 206) {
        console.log(`${label} ${spec} 已可下载（HTTP ${status}，第 ${attempt} 次探测）：${tarball}`)
        return 0
      }
      lastReason = `${tarball} -> HTTP ${status}`
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const waitMs = Math.min(intervalSeconds * 1000, remaining)
    console.log(
      `${label} 第 ${attempt} 次未就绪：${lastReason}；${Math.round(waitMs / 1000)}s 后重试`
        + `（剩余 ${Math.round(remaining / 1000)}s）`,
    )
    await sleep(waitMs)
  }

  console.error(`${label} 等待 ${timeoutSeconds}s 后 ${spec} 仍不可下载：${lastReason}`)
  console.error(`${label} 通常是 npm 发布后的传播延迟；待该版本可下载后重跑本 workflow 即可。`)
  return 1
}

process.exitCode = await main()