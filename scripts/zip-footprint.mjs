#!/usr/bin/env node
// 读取 zip 的中央目录并汇总体积构成（用于对比不同版本的发布包）。
// 只读目录，不真正解压，因此对上百 MB 的产物也很快。
//
// 用法: node scripts/zip-footprint.mjs <a.zip> [b.zip ...] [--top=15]
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const args = process.argv.slice(2)
const topN = Number((args.find((a) => a.startsWith('--top=')) ?? '--top=15').split('=')[1])
const files = args.filter((a) => !a.startsWith('--'))

const MiB = 1024 * 1024
const mib = (bytes) => (bytes / MiB).toFixed(1)

// 定位 EOCD（可能带注释，所以在最后 64KiB 内从后往前找）。
function findEocd(buffer) {
  const start = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

function readEntries(buffer) {
  const eocd = findEocd(buffer)
  if (eocd === -1) throw new Error('找不到 zip EOCD 记录（不是 zip 或已损坏）')
  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)

  const entries = []
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`中央目录第 ${i} 项签名不匹配`)
    }
    const compressed = buffer.readUInt32LE(offset + 20)
    const uncompressed = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, compressed, uncompressed })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const TOP_LEVEL = (name) => {
  const parts = name.split('/')
  if (parts[0] === '' ) return parts[1] ?? ''
  return parts[0]
}

// 归到「包」一级：node_modules/@scope/pkg 或 node_modules/pkg。
function packageOf(name) {
  const parts = name.split('/').filter(Boolean)
  const nmIndex = parts.indexOf('node_modules')
  if (nmIndex === -1) return `<root>/${parts[0] ?? ''}`
  const scope = parts[nmIndex + 1]
  if (!scope) return '<root>'
  if (scope.startsWith('@')) return `${scope}/${parts[nmIndex + 2] ?? ''}`
  return scope
}

// 用本地文件头解出单个条目（artifact 包装 zip 里通常只含内层发布包一个文件）。
// 返回是否解出，以及是否还有更多条目。
function extractEntry(buffer, index, outPath) {
  const eocd = findEocd(buffer)
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let i = 0; i < index; i += 1) {
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    offset += 46 + nameLength + extraLength + commentLength
  }
  const method = buffer.readUInt16LE(offset + 10)
  const compressed = buffer.readUInt32LE(offset + 20)
  const nameLength = buffer.readUInt16LE(offset + 28)
  const extraLength = buffer.readUInt16LE(offset + 30)
  const commentLength = buffer.readUInt16LE(offset + 32)
  const localOffset = buffer.readUInt32LE(offset + 42)
  const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

  const localNameLength = buffer.readUInt16LE(localOffset + 26)
  const localExtraLength = buffer.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + localNameLength + localExtraLength
  const data = buffer.subarray(dataStart, dataStart + compressed)

  if (method === 0) {
    writeFileSync(outPath, data)
  } else if (method === 8) {
    writeFileSync(outPath, inflateRawSync(data))
  } else {
    throw new Error(`不支持的压缩方式 ${method}（${name}）`)
  }
  return name
}

for (const file of files) {
  let buffer = readFileSync(file)
  let entries = readEntries(buffer)

  // 外层 artifact 包装：只有 1 个非目录条目且是 .zip 时，继续往里看一层。
  let label = basename(file)
  const outerEntries = entries.filter((entry) => !entry.name.endsWith('/'))
  if (outerEntries.length === 1 && outerEntries[0].name.endsWith('.zip')) {
    const innerPath = join(tmpdir(), `zip-footprint-${process.pid}-inner.zip`)
    extractEntry(buffer, entries.indexOf(outerEntries[0]), innerPath)
    label = `${basename(file)} -> ${outerEntries[0].name}`
    buffer = readFileSync(innerPath)
    entries = readEntries(buffer)
  }

  const realEntries = entries.filter((entry) => !entry.name.endsWith('/'))

  const byPackage = new Map()
  const byExtension = new Map()
  let rawTotal = 0
  let zipTotal = 0

  for (const entry of realEntries) {
    rawTotal += entry.uncompressed
    zipTotal += entry.compressed
    const pkg = packageOf(entry.name)
    byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + entry.uncompressed)
    const dot = entry.name.lastIndexOf('.')
    const base = entry.name.slice(entry.name.lastIndexOf('/') + 1)
    const ext = dot > entry.name.lastIndexOf('/') ? entry.name.slice(dot) : '<no-ext>'
    byExtension.set(ext, (byExtension.get(ext) ?? 0) + entry.uncompressed)
    void base
  }

  console.log(`\n=== ${basename(file)} ===`)
  console.log(`${realEntries.length} 个文件；解压后 ${mib(rawTotal)} MiB；zip 内 ${mib(zipTotal)} MiB`)
  void TOP_LEVEL

  console.log(`最大的 ${topN} 个包（解压后体积）:`)
  for (const [name, bytes] of [...byPackage.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
    console.log(`  ${mib(bytes).padStart(9)} MiB  ${name}`)
  }
  console.log('按扩展名:')
  for (const [ext, bytes] of [...byExtension.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${mib(bytes).padStart(9)} MiB  ${ext}`)
  }
}
