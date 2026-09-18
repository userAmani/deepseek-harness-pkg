#!/usr/bin/env node
// 验证 .github/workflows/*.yml（改 workflow 后的自检，不属于发布流程）：
//   1. 每个 job 都能定位，且 steps / outputs 结构完整；
//   2. 表达式能落地：`steps.<id>`、`needs.<job>`、`needs.<job>.outputs.<name>`、
//      `<job>.outputs.<name>` 必须对应真实存在的 step id / job / output；
//   3. 每个 run: 块的 shell 语法通过 `bash -n`。
//
// 第 2 项是必要的：往 workflow 里插步骤时很容易顺手把 `id:` 冲掉，而这类错误
// 要等运行时求值才炸（sync job 的 output 全部变空、build 因此不触发）。
//
// 刻意不引入 YAML 库：仓库没有把 `yaml` 声明为依赖（它只是被提升上来的间接
// 依赖），直接 import 会在干净的 checkout / CI 里 ERR_MODULE_NOT_FOUND。
// 这里用「按缩进切块」的极简解析 —— 只针对本仓库这几个 workflow，且失败时
// 直接报错（不静默通过）。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = '.github/workflows'
const files = readdirSync(dir).filter((f) => f.endsWith('.yml')).sort()

let failures = 0
const fail = (message) => {
  failures += 1
  console.log(`FAIL ${message}`)
}

const indentOf = (line) => line.length - line.trimStart().length
const isBlank = (line) => line.trim() === ''
const isComment = (line) => /^\s*#/.test(line)
const unquote = (value) => value.replace(/^['"]|['"]$/g, '').trim()

// 把文件按行切好，并记录每行的缩进。
function indexLines(text) {
  return text.split(/\r?\n/).map((line) => ({ line, indent: indentOf(line) }))
}

// 把 `run: |` 的字面量块内容取出来（去掉相对于 `run:` 的公共缩进）。
function finalizeRun(step, rows) {
  if (!step.runIsBlock) return
  const collected = []
  for (let i = step.runIndex + 1; i < step.end; i += 1) {
    const row = rows[i]
    if (isBlank(row.line)) {
      collected.push('')
      continue
    }
    if (row.indent <= step.blockIndent) break
    collected.push(row.line.slice(step.blockIndent + 2))
  }
  step.run = collected.join('\n')
}

// ---------------------------------------------------------------------------
// 解析一个 workflow：jobs -> 每个 job 的 steps / outputs / 文本片段
// ---------------------------------------------------------------------------
function parseWorkflow(text) {
  const lines = text.split(/\r?\n/)
  if (!lines.some((line) => /^jobs:\s*$/.test(line))) return null

  const rows = indexLines(text)
  // jobs: 之后、缩进恰为 2 的 `key:` 就是 job id。
  const jobRows = []
  let insideJobs = false
  for (const row of rows) {
    if (!insideJobs) {
      if (/^jobs:\s*$/.test(row.line)) insideJobs = true
      continue
    }
    if (isBlank(row.line) || isComment(row.line)) continue
    if (row.indent === 0) break // 离开 jobs 段
    if (row.indent === 2) jobRows.push(row)
  }

  const jobs = {}
  const jobOrder = []
  for (const row of jobRows) {
    const match = row.line.trim().match(/^([A-Za-z0-9_-]+):\s*$/)
    if (!match) continue
    jobOrder.push(match[1])
  }

  // 每个 job 的文本片段 = 从它的 `jobId:` 行到下一个 job 的 `jobId:` 行。
  const bounds = jobOrder.map((jobId) => {
    const start = lines.findIndex((line) => new RegExp(`^ {2}${jobId}:\\s*$`).test(line))
    return { jobId, start }
  })

  for (const [index, bound] of bounds.entries()) {
    const end = index + 1 < bounds.length ? bounds[index + 1].start : lines.length
    const jobLines = lines.slice(bound.start + 1, end)
    const jobRows = indexLines(jobLines.join('\n'))

    const job = {
      steps: [],
      stepIds: new Set(),
      outputs: new Set(),
      usesChildWorkflow: jobLines.some((line) => /^ {4}uses:\s*/.test(line)),
      text: jobLines.filter((line) => !isComment(line)).join('\n'),
    }

    // steps：缩进 6 的 `- ` 开头的新条目，字段在缩进 >= 8。
    const stepsStart = jobRows.findIndex((row) => /^ {4}steps:\s*$/.test(row.line))
    if (stepsStart !== -1) {
      const afterSteps = jobRows.slice(stepsStart + 1)
      let current = null
      let currentEnd = 0
      const steps = []
      for (const [rowIndex, row] of afterSteps.entries()) {
        if (isBlank(row.line) || isComment(row.line)) continue
        if (row.indent < 6) break
        if (row.indent === 6 && /^\s*-\s/.test(row.line)) {
          if (current) {
            current.end = rowIndex
            finalizeRun(current, afterSteps)
          }
          current = { id: null, run: null, name: null, uses: null, runIsBlock: false, runIndex: -1 }
          steps.push(current)
          const inline = row.line.trim().replace(/^-\s*/, '')
          const inlineMatch = inline.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
          if (inlineMatch) {
            const [, key, value] = inlineMatch
            if (key === 'id') current.id = unquote(value)
            else if (key === 'name') current.name = unquote(value)
            else if (key === 'uses') current.uses = value
            else if (key === 'run') current.run = value
          }
          continue
        }
        if (!current || row.indent < 8) continue
        const fieldMatch = row.line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
        if (!fieldMatch) continue
        const [, key, rawValue] = fieldMatch
        const value = rawValue.trim()
        if (key === 'id') current.id = unquote(value)
        else if (key === 'name') current.name = unquote(value)
        else if (key === 'uses') current.uses = value
        else if (key === 'run') {
          if (/^[|>][-+]?$/.test(value)) {
            // 字面量块：真正的脚本在后面更深缩进的行里。
            current.run = ''
            current.runIsBlock = true
            current.runIndex = rowIndex
            current.blockIndent = row.indent
          } else {
            current.run = value
          }
        }
      }
      if (current) {
        current.end = afterSteps.length
        finalizeRun(current, afterSteps)
      }
      job.steps = steps
    }
    job.stepIds = new Set(job.steps.map((step) => step.id).filter(Boolean))

    // outputs：`outputs:` 下缩进 6 的子键。
    const outputsStart = jobRows.findIndex((row) => /^ {4}outputs:\s*$/.test(row.line))
    if (outputsStart !== -1) {
      for (const row of jobRows.slice(outputsStart + 1)) {
        if (isBlank(row.line) || isComment(row.line)) continue
        if (row.indent <= 4) break
        if (row.indent !== 6) continue
        const match = row.line.trim().match(/^([A-Za-z0-9_-]+):/)
        if (match) job.outputs.add(match[1])
      }
    }

    jobs[bound.jobId] = job
  }

  return { jobOrder, jobs }
}

// ---------------------------------------------------------------------------
// 第一遍：解析全部 workflow，打印 job 概览；同时建立「复用型 workflow 的
// workflow_call.inputs」表，用于校验调用方传的 with: 是否真的被声明。
// ---------------------------------------------------------------------------
const parsed = new Map()
const callableInputs = new Map() // 文件路径（相对仓库根）-> Set(input 名)
for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8')
  const workflow = parseWorkflow(text)
  if (!workflow || workflow.jobOrder.length === 0) {
    fail(`${file}: 没有解析出任何 job（workflow 结构变了？）`)
    continue
  }
  parsed.set(file, workflow)

  // `.github/workflows/x.yml` -> `.github/workflows/x.yml`（相对仓库根的 uses 路径）
  const inputs = new Set()
  const callIndex = text.split(/\r?\n/).findIndex((line) => /^  workflow_call:\s*$/.test(line))
  if (callIndex !== -1) {
    const lines = text.split(/\r?\n/)
    let inInputs = false
    for (let i = callIndex + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (isBlank(line) || isComment(line)) continue
      const indent = indentOf(line)
      if (indent <= 2) break // 离开 workflow_call 块
      if (/^ {4}inputs:\s*$/.test(line)) {
        inInputs = true
        continue
      }
      if (indent === 4 && !/^ {4}inputs:\s*$/.test(line)) inInputs = false
      if (inInputs && indent === 6) {
        const match = line.trim().match(/^([A-Za-z0-9_-]+):/)
        if (match) inputs.add(match[1])
      }
    }
  }
  callableInputs.set(`./${join(dir, file).replace(/\\/g, '/')}`, inputs)

  console.log(`OK   ${file}: ${workflow.jobOrder.length} jobs (${workflow.jobOrder.join(', ')})`)
}

// ---------------------------------------------------------------------------
// 第二遍：引用校验 + shell 语法
// ---------------------------------------------------------------------------
const refPattern = /\b(steps|needs)\.([A-Za-z0-9_-]+)(?:\.outputs\.([A-Za-z0-9_-]+))?/g

for (const [file, workflow] of parsed) {
  const jobIds = workflow.jobOrder

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const label = `${file}#${jobId}`

    const seen = new Set()
    for (const match of job.text.matchAll(refPattern)) {
      const [, scope, name, output] = match
      const key = `${scope}.${name}.${output ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)

      if (scope === 'steps' && !job.stepIds.has(name)) {
        fail(`${label}: 引用了不存在的 step id \`${name}\`（本 job 的 id: ${[...job.stepIds].join(', ') || '无'}）`)
      }
      if (scope === 'needs') {
        // needs 的目标可能是普通 job，也可能指向本文件里 `uses: ./...` 的
        // 复用型 job（它本身仍是真实 job id，要放行）；完全不存在就是拼写错误。
        if (!jobIds.includes(name)) {
          fail(`${label}: 引用了不存在的 job \`${name}\`（本文件 job: ${jobIds.join(', ')}）`)
        }
      }
    }

    for (const match of job.text.matchAll(/needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
      const [, needJob, output] = match
      const target = workflow.jobs[needJob]
      if (!target || target.usesChildWorkflow) continue // 复用型 workflow 的输出名在子 workflow 定义
      if (!target.outputs.has(output)) {
        fail(`${label}: needs.${needJob}.outputs.${output} 未声明（${needJob} 已声明: ${[...target.outputs].join(', ') || '无'}）`)
      }
    }

    // `needs:` 的序列写法（`needs: a` / `needs: [a, b]`）不含点号，上面的
    // refPattern 抓不到，这里单独校验 job id 拼写。
    for (const match of job.text.matchAll(/^\s*needs:\s*(.+)$/gm)) {
      const raw = match[1].trim()
      const names = raw.startsWith('[')
        ? raw.replace(/^\[|\]$/g, '').split(',')
        : [raw]
      for (const name of names.map((n) => unquote(n)).filter(Boolean)) {
        if (!jobIds.includes(name)) {
          fail(`${label}: needs 引用了不存在的 job \`${name}\`（本文件 job: ${jobIds.join(', ')}）`)
        }
      }
    }

    // 复用型 workflow 的调用：`uses: ./.github/workflows/x.yml` + `with:`。
    // 复用型 workflow 不会自动继承调用方的 input —— 忘了在子 workflow 的
    // `workflow_call.inputs` 里声明，传进去的值会被静默忽略。这里显式校验。
    const usesMatch = job.text.match(/^\s*uses:\s*(\S+)\s*$/m)
    if (usesMatch && usesMatch[1].startsWith('./')) {
      const callee = usesMatch[1]
      const declared = callableInputs.get(callee)
      if (declared === undefined) {
        fail(`${label}: uses 指向了本仓库里找不到的 workflow \`${callee}\``)
      } else {
        const withIndex = job.text.split(/\r?\n/).findIndex((line) => /^ {4}with:\s*$/.test(line))
        if (withIndex !== -1) {
          const lines = job.text.split(/\r?\n/)
          for (let i = withIndex + 1; i < lines.length; i += 1) {
            const line = lines[i]
            if (isBlank(line) || isComment(line)) continue
            if (indentOf(line) <= 4) break
            if (indentOf(line) !== 6) continue
            const match = line.trim().match(/^([A-Za-z0-9_-]+):/)
            if (match && !declared.has(match[1])) {
              fail(`${label}: 向 ${callee} 传了未声明的 input \`${match[1]}\`（已声明: ${[...declared].join(', ') || '无'}）`)
            }
          }
        }
      }
    }

    for (const match of job.text.matchAll(new RegExp(`\\b${jobId}\\.outputs\\.([A-Za-z0-9_-]+)`, 'g'))) {
      const [, output] = match
      if (!job.outputs.has(output)) {
        fail(`${label}: ${jobId}.outputs.${output} 未声明（已声明: ${[...job.outputs].join(', ') || '无'}）`)
      }
    }

    if (job.steps.length === 0) {
      if (!job.usesChildWorkflow) fail(`${label}: 既没有解析出 steps，也没有 uses 子 workflow`)
      continue
    }

    for (const [index, step] of job.steps.entries()) {
      if (typeof step.run !== 'string' || step.run === '') continue
      const stepLabel = `${label}[${index}] ${step.name ?? '(unnamed)'}`
      const temp = join(mkdtempSync(join(tmpdir(), 'wfcheck-')), 'step.sh')
      writeFileSync(temp, step.run)
      try {
        execFileSync('bash', ['-n', temp], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        fail(`${stepLabel}: bash -n 失败\n${(err.stderr || err.stdout || '').toString().trim()}`)
      }
    }
  }
}

if (failures > 0) {
  console.log(`\n${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n全部 workflow 结构、表达式引用与 shell 语法检查通过')
