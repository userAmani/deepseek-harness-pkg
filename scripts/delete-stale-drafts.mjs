#!/usr/bin/env node
// 删除「同一版本、上一次尝试留下来」的 draft release，让发布可以安全重跑。
//
// 背景：run 35242697914 第一次尝试在资产上传中途以 `Headers Timeout Error`
// 失败，却留下了一个半成品 draft（tag `dsh-0.1.6-alpha.2-35242697914`）。
// draft release **没有对应的 git ref**，所以它既不会出现在
// `gh release list --exclude-pre-releases` 里，也无法通过 tag 查到
// （`softprops/action-gh-release` 日志里的
// "Release ... is not yet discoverable by tag ..., retrying..." 就是这个现象）。
// 结果是重跑时旧 draft 一直挂着，还会和同名 tag 撞车。
// 发布前先按前缀清掉它们，重跑才是幂等的。
//
// 用法:
//   node scripts/delete-stale-drafts.mjs --prefix=dsh-0.1.6-alpha.2-
//   node scripts/delete-stale-drafts.mjs --prefix=dsh-src-0.1.3-alpha.1- --dry-run
//
// 环境变量: GH_TOKEN / GITHUB_TOKEN 必须有 contents:write 权限。
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(`--${name}`)
const argValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const prefix = argValue('prefix', '')
const repo = argValue('repo', process.env.GITHUB_REPOSITORY ?? '')
const dryRun = hasFlag('dry-run')

if (!prefix) {
  console.error('[delete-stale-drafts] 必须提供 --prefix=<tag 前缀>，例如 --prefix=dsh-0.1.6-alpha.2-')
  process.exit(1)
}
if (!repo) {
  console.error('[delete-stale-drafts] 必须提供 --repo=<owner/name> 或设置 GITHUB_REPOSITORY')
  process.exit(1)
}

const run = (ghArgs) =>
  execFileSync('gh', ghArgs, { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })

// --paginate 保证超过 30 个 release 时也不会漏。
let releases
try {
  releases = JSON.parse(run(['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp']))
    .flat()
} catch (err) {
  console.error(`[delete-stale-drafts] 列出 release 失败: ${err.message}`)
  process.exit(1)
}

// 安全阀：只认「<prefix><run_id>」形态，避免前缀写短了误删别的发布。
// run_id 是 GitHub 的全局递增 id（当前 11 位），要求至少 6 位数字。
const safeTag = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d{6,}$`)

const stale = releases.filter(
  (release) => release?.draft === true && typeof release.tag_name === 'string' && safeTag.test(release.tag_name),
)

if (stale.length === 0) {
  console.log(`[delete-stale-drafts] 没有匹配 ${prefix}<run_id> 的 draft，无需清理`)
  process.exit(0)
}

for (const release of stale) {
  console.log(
    `[delete-stale-drafts] draft ${release.tag_name} (id=${release.id}, ` +
      `assets=${release.assets?.length ?? 0})${dryRun ? ' [dry-run]' : ''}`,
  )
}

if (dryRun) {
  console.log(`[delete-stale-drafts] --dry-run：未删除 ${stale.length} 个 draft`)
  process.exit(0)
}

let failed = 0
for (const release of stale) {
  try {
    run(['api', '--method', 'DELETE', `repos/${repo}/releases/${release.id}`])
    console.log(`[delete-stale-drafts] 已删除 draft ${release.tag_name}`)
  } catch (err) {
    failed += 1
    console.error(`[delete-stale-drafts] 删除 draft ${release.tag_name} 失败: ${err.message}`)
  }
}

if (failed > 0) {
  console.error(`[delete-stale-drafts] ${failed} 个 draft 删除失败；不继续发布，避免和残留 release 撞车`)
  process.exit(1)
}

console.log(`[delete-stale-drafts] 清理完成，共删除 ${stale.length} 个 draft`)
