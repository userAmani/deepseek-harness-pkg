#!/usr/bin/env node
// 对 scripts/check-workflows.mjs 做反向测试：每项都注入一个真实错误，
// 确认校验器能报出来，然后还原文件。仅本地自检用。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const target = '.github/workflows/sync-release.yml'
const original = readFileSync(target, 'utf8')

const cases = [
  {
    name: '干掉 step id (`id: resolve`)',
    mutate: (text) => text.replace(/^        id: resolve\r?\n/m, ''),
    expect: /不存在的 step id `resolve`/,
  },
  {
    name: 'job output 改名 (version -> versions)',
    mutate: (text) => text.replace(/^      version: \$\{\{ steps\.resolve/m, '      versions: ${{ steps.resolve'),
    expect: /needs\.sync\.outputs\.version 未声明/,
  },
  {
    name: 'needs 指向不存在的 job',
    mutate: (text) => text.replace(/^    needs: \[sync, build\]/m, '    needs: [sync, buidl]'),
    expect: /不存在的 job `buidl`|needs\.buidl/,
  },
  {
    name: 'run 块里的 shell 语法错误',
    mutate: (text) => text.replace(/^          set -euo pipefail\r?\n/m, '          if [ -z "$target" ; then\n'),
    expect: /bash -n 失败/,
  },
  {
    name: '向子 workflow 传未声明的 input',
    mutate: (text) =>
      text.replace(
        /^      dsh_version: \$\{\{ needs\.sync\.outputs\.version \}\}$/m,
        "      dsh_version: ${{ needs.sync.outputs.version }}\n      typo_input: 'x'",
      ),
    expect: /未声明的 input `typo_input`/,
  },
]

let failures = 0
try {
  for (const testCase of cases) {
    writeFileSync(target, testCase.mutate(original))
    let output = ''
    let exitCode = 0
    try {
      output = execFileSync('node', ['scripts/check-workflows.mjs'], { encoding: 'utf8' })
    } catch (err) {
      exitCode = err.status ?? 1
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    const detected = exitCode !== 0 && testCase.expect.test(output)
    console.log(`${detected ? 'PASS' : 'FAIL'}  ${testCase.name}`)
    if (!detected) {
      failures += 1
      console.log(`      期望匹配 ${testCase.expect}，实际退出码 ${exitCode}`)
      console.log(output.split(/\r?\n/).filter((line) => line.startsWith('FAIL')).join('\n'))
    }
  }
} finally {
  writeFileSync(target, original)
}

// 还原后必须重新通过。
let cleanExit = 0
try {
  execFileSync('node', ['scripts/check-workflows.mjs'], { encoding: 'utf8' })
} catch (err) {
  cleanExit = err.status ?? 1
}
console.log(`${cleanExit === 0 ? 'PASS' : 'FAIL'}  还原后校验通过`)
if (cleanExit !== 0) failures += 1

console.log(failures === 0 ? '\n反向测试全部通过' : `\n${failures} 项反向测试失败`)
process.exit(failures === 0 ? 0 : 1)
