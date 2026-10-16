#!/usr/bin/env node
/**
 * check-no-leaks.cjs — 提交前隐私自检
 *
 * 扫描仓库内所有产物，确认没有把本机路径、用户名、会话 ID 等个人信息带进开源仓库。
 * 退出码 0 = 干净；1 = 发现问题。
 *
 * 用法：node check-no-leaks.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const USERNAME = path.basename(HOME);

// 跳过这些目录/文件
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SCAN_EXT = new Set(['.html', '.json', '.cjs', '.js', '.md', '.txt', '.yml', '.yaml']);

/**
 * 读取 .gitignore 的关键规则，用于区分：
 *  - 会被提交的文件（问题 → 直接失败）
 *  - 已被忽略的文件（只是本地产物 → 仅提示）
 * 只支持本项目用到的简单规则（文件名 / 通配 / 目录 / !取反）。
 */
function loadIgnore() {
  const rules = [];
  const gi = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(gi)) return rules;
  for (let line of fs.readFileSync(gi, 'utf8').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    if (neg) line = line.slice(1);
    rules.push({ neg, re: globToRe(line) });
  }
  return rules;
}
function globToRe(g) {
  // 转义正则特殊字符，再把 * / ** 转成通配
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
               .replace(/\*\*/g, '\u0000')
               .replace(/\*/g, '[^/]*')
               .replace(/\u0000/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}
const IGNORE = loadIgnore();
/** 判断相对路径是否被 .gitignore 忽略（后者优先） */
function isIgnored(rel) {
  const p = rel.replace(/\\/g, '/');
  let ignored = false;
  for (const r of IGNORE) {
    const base = p.split('/').pop();
    if (r.re.test(p) || r.re.test(base)) ignored = !r.neg;
  }
  return ignored;
}

/** 需要检测的模式 → 说明 */
const PATTERNS = [
  { re: new RegExp(escapeRe(HOME), 'gi'), name: '本机绝对 home 路径', severity: 'high' },
  { re: /[A-Za-z]:\\Users\\[^\\\s"']+/g, name: 'Windows 用户目录路径', severity: 'high' },
  { re: /[A-Za-z]:\/Users\/[^/\s"']+/g, name: 'Windows 用户目录路径（正斜杠）', severity: 'high' },
  { re: /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, name: '会话 UUID', severity: 'high' },
  { re: /\.credentials\.yaml/gi, name: '凭据文件引用', severity: 'high' },
  { re: /\bsk-[A-Za-z0-9_-]{12,}/g, name: '疑似 API key', severity: 'high' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, name: '疑似 AWS key', severity: 'high' },
  { re: /\bghp_[A-Za-z0-9]{20,}/g, name: '疑似 GitHub token', severity: 'high' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, name: '疑似 GitHub PAT', severity: 'high' },
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const findings = [];

function scanFile(abs) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
  const rel = path.relative(ROOT, abs);
  const ignored = isIgnored(rel);
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      // 去重并截断展示，避免把敏感值原样打印出来
      const uniq = [...new Set(m)];
      findings.push({
        file: rel, kind: p.name, severity: p.severity,
        count: m.length, ignored,
        samples: uniq.slice(0, 3).map(redact)
      });
    }
  }
}

/** 打码：只留首尾，绝不回显完整值 */
function redact(s) {
  const str = String(s);
  if (str.length <= 8) return str.slice(0, 2) + '…';
  return str.slice(0, 6) + '…' + str.slice(-3);
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    // 文件名本身可能带用户名（云同步冲突副本尤其常见）
    if (/(SFConflict|conflict|冲突|DESKTOP-|sync-conflict)/i.test(name)) {
      findings.push({
        file: path.relative(ROOT, path.join(dir, name)),
        kind: '疑似云同步冲突副本（文件名可能含用户名）',
        severity: 'high', count: 1, ignored: isIgnored(path.relative(ROOT, path.join(dir, name))),
        samples: [redact(name)]
      });
    }
    const abs = path.join(dir, name);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) { walk(abs); continue; }
    if (!SCAN_EXT.has(path.extname(name).toLowerCase())) continue;
    scanFile(abs);
  }
}

console.log('隐私自检：扫描 ' + ROOT);
if (USERNAME) console.log('（同时检测本机用户名 / home 路径）');
console.log('');

walk(ROOT);

// 区分：会进仓库的（严重） vs 已被 .gitignore 忽略的本地产物（仅提示）
const blocking = findings.filter(f => !f.ignored);
const ignored = findings.filter(f => f.ignored);

if (blocking.length === 0 && ignored.length === 0) {
  console.log('✓ 未发现泄漏：没有本机路径、用户名、会话 ID 或疑似密钥。');
  console.log('  可以安全提交 / 开源。');
  process.exit(0);
}

if (ignored.length > 0) {
  console.log('ℹ 以下本地产物含真实数据，但已被 .gitignore 忽略（不会进仓库）：\n');
  const byFile = {};
  for (const f of ignored) (byFile[f.file] = byFile[f.file] || []).push(f.kind + '×' + f.count);
  for (const [file, kinds] of Object.entries(byFile)) {
    console.log('  ' + file + '  →  ' + kinds.join(', '));
  }
  console.log('');
}

if (blocking.length === 0) {
  console.log('✓ 没有会被提交的泄漏。可以安全提交 / 开源。');
  console.log('  （上面列出的本地产物请勿强行 git add -f）');
  process.exit(0);
}

console.log('✗ 发现 ' + blocking.length + ' 处**会被提交**的问题：\n');
for (const f of blocking) {
  console.log('  [' + f.severity.toUpperCase() + '] ' + f.file);
  console.log('        类型: ' + f.kind + '  (命中 ' + f.count + ' 次)');
  console.log('        样例: ' + f.samples.join(' , '));
  console.log('');
}
console.log('请先处理这些问题再提交。');
console.log('提示：真实数据产物应加入 .gitignore，不应进仓库。');
process.exit(1);
