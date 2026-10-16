#!/usr/bin/env node
/**
 * dsh-usage-collect.cjs — DSH 每日 token 用量采集器（只读）
 *
 * 数据源：~/.dsh/sessions/<ws>/session-<uuid>/session.v4.jsonl.zstd
 *         回退：session.jsonl.zstd（仅在 v4 不存在时）
 *         兜底：~/.dsh/storages/session_projcache/sessions/*.json（进行中的会话）
 *
 * 计费口径：total = inputTokens(未缓存) + cacheReadTokens + outputTokens
 *          （旧日志无 totalTokens 字段时自行求和）
 *
 * 金额：按 DeepSeek 官方价目表 + 峰谷定价计费（见 dsh-pricing.cjs）
 *      金额按 provider 分账：official（deepseek-official）/ ustc（各 USTC 网关）
 *
 * 用法：
 *   node dsh-usage-collect.cjs [输出json路径]   采集真实数据
 *   node dsh-usage-collect.cjs --demo [输出]    生成合成示例数据（不含真实用量）
 * 本脚本只读 DSH 目录，绝不写入。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pricing = require('./dsh-pricing.cjs');

const DEMO = process.argv.includes('--demo');
const args = process.argv.slice(2).filter(a => a !== '--demo');
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh');
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
const OUT = args[0] || path.join(process.cwd(), 'dsh-usage-daily.json');

/** 脱敏：把本机绝对路径换成 ~ 形式，避免把用户名带进可分享的产物 */
function sanitizePath(p) {
  let s = String(p || '');
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    s = s.split(home).join('~');
    // 同时处理正/反斜杠两种写法
    s = s.split(home.replace(/\\/g, '/')).join('~');
  }
  return s;
}

/** 把 provider 归类：official = DeepSeek 官方；ustc = USTC 各网关；other = 其它 */
function providerClass(p) {
  const s = String(p || '').toLowerCase();
  if (s.startsWith('deepseek-official') || s === 'deepseek') return 'official';
  if (s.startsWith('ustc')) return 'ustc';
  return 'other';
}

/** 逐帧解压多帧 zstd 并解析 JSONL（尾部半帧自动跳过） */
function readLog(p) {
  const raw = fs.readFileSync(p);
  const idx = [];
  let i = 0;
  while ((i = raw.indexOf(MAGIC, i)) !== -1) { idx.push(i); i++; }
  if (idx.length === 0) return [];
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1] : raw.length;
    let text;
    try { text = zlib.zstdDecompressSync(raw.subarray(idx[k], end)).toString('utf8'); }
    catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* 忽略坏行 */ }
    }
  }
  return out;
}

const emptyDay = () => ({
  req: 0, uncached: 0, out: 0, cache: 0, total: 0,
  subagentReq: 0, subagentTotal: 0,
  cost: 0,            // 总金额（official + ustc + other）
  costOfficial: 0,
  costUstc: 0,
  costOther: 0,
  peakReq: 0, peakCost: 0,
  offReq: 0, offCost: 0
});

// ---------------------------------------------------------------------------
// 合成示例数据（--demo）：可复现的伪随机，不含任何真实用量
// 用途：生成可安全分享/开源的示例报表
// ---------------------------------------------------------------------------
function buildDemo() {
  const byDay = Object.create(null);
  // 固定种子的线性同余，保证每次生成结果一致
  let seed = 20261016;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const start = new Date('2026-07-01T00:00:00Z');
  const DAYS = 60;
  const MODELS = [
    { name: 'deepseek-flash',   w: 0.72 },
    { name: 'deepseek-v4-pro',  w: 0.10 },
    { name: 'deepseek-v4-flash',w: 0.18 }
  ];
  const byModel = Object.create(null);
  const byProviderClass = Object.create(null);
  const perSession = [];

  for (let i = 0; i < DAYS; i++) {
    const dt = new Date(start.getTime() + i * 86400000);
    const day = dt.toISOString().slice(0, 10);
    const dow = dt.getUTCDay();
    // 工作日多、周末少，并叠加轻微噪声 —— 让示例图有真实感
    const base = (dow === 0 || dow === 6) ? 0.25 : 1.0;
    const wave = 0.75 + 0.5 * Math.sin(i / 6);
    const req = Math.round((60 + rnd() * 220) * base * wave);
    if (req <= 0) continue;

    const d = byDay[day] = emptyDay();
    d.req = req;
    // 每次请求约 3~6 万缓存读、少量未缓存输入、几百输出
    d.cache = Math.round(req * (30000 + rnd() * 30000));
    d.uncached = Math.round(req * (1500 + rnd() * 3000));
    d.out = Math.round(req * (250 + rnd() * 500));
    d.total = d.cache + d.uncached + d.out;

    // 用真实计价引擎算金额（峰谷按日期自动判定）
    const midday = dt.getTime() + 10 * 3600 * 1000;  // 北京时间 18:00，多为空闲
    const peakT  = dt.getTime() + 2 * 3600 * 1000;   // 北京时间 10:00，工作日内为高峰
    const peakShare = (dow === 0 || dow === 6) ? 0 : 0.35;
    const cPeak = pricing.costOf(peakT, 'deepseek-flash', d.uncached * peakShare, d.cache * peakShare, d.out * peakShare);
    const cOff  = pricing.costOf(midday, 'deepseek-flash', d.uncached * (1 - peakShare), d.cache * (1 - peakShare), d.out * (1 - peakShare));
    d.peakReq = Math.round(req * peakShare);
    d.offReq = req - d.peakReq;
    d.peakCost = cPeak;
    d.offCost = cOff;
    d.cost = cPeak + cOff;
    // 示例中官方 40% / USTC 60%
    d.costOfficial = d.cost * 0.40;
    d.costUstc = d.cost * 0.60;

    for (const m of MODELS) {
      const bm = byModel[m.name] || (byModel[m.name] = {
        total: 0, req: 0, uncached: 0, cache: 0, out: 0, cost: 0, costOfficial: 0, costUstc: 0, costOther: 0
      });
      bm.total += d.total * m.w; bm.req += Math.round(req * m.w);
      bm.uncached += d.uncached * m.w; bm.cache += d.cache * m.w; bm.out += d.out * m.w;
      bm.cost += d.cost * m.w; bm.costOfficial += d.costOfficial * m.w; bm.costUstc += d.costUstc * m.w;
    }
    byProviderClass.official = byProviderClass.official || { req: 0, total: 0, cost: 0 };
    byProviderClass.ustc = byProviderClass.ustc || { req: 0, total: 0, cost: 0 };
    byProviderClass.official.req += Math.round(req * 0.4);
    byProviderClass.official.total += d.total * 0.4; byProviderClass.official.cost += d.costOfficial;
    byProviderClass.ustc.req += req - Math.round(req * 0.4);
    byProviderClass.ustc.total += d.total * 0.6; byProviderClass.ustc.cost += d.costUstc;
  }

  const days = Object.keys(byDay).sort();
  const sum = (f) => days.reduce((a, k) => a + f(byDay[k]), 0);
  const totals = {
    req: sum(d => d.req), uncached: sum(d => d.uncached), cache: sum(d => d.cache),
    out: sum(d => d.out), total: sum(d => d.total),
    cost: sum(d => d.cost), costOfficial: sum(d => d.costOfficial),
    costUstc: sum(d => d.costUstc), costOther: 0,
    peakReq: sum(d => d.peakReq), peakCost: sum(d => d.peakCost),
    offReq: sum(d => d.offReq), offCost: sum(d => d.offCost)
  };

  return {
    demo: true,
    generatedAt: new Date().toISOString(),
    source: '~/.dsh（示例数据 · 非真实用量）',
    pricing: {
      currency: 'CNY',
      source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      note: '按 DeepSeek 官方价目表 + 峰谷定价；旧模型名 deepseek-v4-flash* 按 Flash 价；非 DeepSeek 模型按 Flash 价折算',
      peakRule: '北京时间 周一至周五（不含法定节假日）09:00-12:00、14:00-18:00',
      holidays2026: ['2026-09-25', '2026-09-26', '2026-09-27',
                     '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
                     '2026-10-05', '2026-10-06', '2026-10-07'],
      makeupWorkdays: ['2026-09-20', '2026-10-10'],
      table: pricing.PRICES
    },
    stats: {
      sessions: 0, filesV4: 0, filesLegacy: 0, requests: totals.req,
      deduped: 0, warnings: [], days: days.length,
      firstDay: days[0], lastDay: days[days.length - 1]
    },
    byProviderClass, byModel,
    totals,
    daily: days.map(k => ({ day: k, ...byDay[k] })),
    sessions: perSession
  };
}

function main() {
  const yuan = n => '¥' + n.toFixed(2);

  // ---- 示例模式：直接产出合成数据，不读取任何真实日志 ----
  if (DEMO) {
    const result = buildDemo();
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    console.log('DSH 用量采集完成（示例数据 · 非真实用量）');
    console.log('  天数     : ' + result.stats.days + '  (' + result.stats.firstDay + ' → ' + result.stats.lastDay + ')');
    console.log('  请求数   : ' + result.totals.req.toLocaleString());
    console.log('  总 token : ' + result.totals.total.toLocaleString());
    console.log('  总金额   : ' + yuan(result.totals.cost));
    console.log('  输出     : ' + OUT);
    return;
  }

  const byDay = Object.create(null);
  const byModel = Object.create(null);
  const byProviderClass = Object.create(null);
  const perSession = [];
  const stats = { sessions: 0, filesV4: 0, filesLegacy: 0, requests: 0, deduped: 0, warnings: [] };

  const sessionsRoot = path.join(DSH_HOME, 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    console.error('找不到 sessions 目录: ' + sessionsRoot);
    process.exit(1);
  }

  // ---- 1. 扫描会话日志（v4 优先） ----
  for (const ws of fs.readdirSync(sessionsRoot)) {
    const wsDir = path.join(sessionsRoot, ws);
    let wsStat; try { wsStat = fs.statSync(wsDir); } catch { continue; }
    if (!wsStat.isDirectory()) continue;

    for (const s of fs.readdirSync(wsDir)) {
      const sDir = path.join(wsDir, s);
      let st; try { st = fs.statSync(sDir); } catch { continue; }
      if (!st.isDirectory()) continue;

      const v4 = path.join(sDir, 'session.v4.jsonl.zstd');
      const legacy = path.join(sDir, 'session.jsonl.zstd');
      // 会话目录名有两种约定：'session-<uuid>' 与裸 '<uuid>'
      const uuid = s.replace(/^session-/, '');
      let file = null;
      if (fs.existsSync(v4)) { file = v4; stats.filesV4++; }
      else if (fs.existsSync(legacy)) { file = legacy; stats.filesLegacy++; stats.warnings.push('legacy-only: ' + s); }
      else continue;   // 进行中的会话无日志 → 后面用 projcache 兜底

      let recs;
      try { recs = readLog(file); } catch (e) { stats.warnings.push('readfail ' + s + ': ' + e.message); continue; }
      stats.sessions++;

      // 模型 / provider：优先 model/selection，回退 request/header.header.config
      let model = 'unknown', provider = 'unknown';
      for (const r of recs) {
        if (r.type === 'model/selection' && r.data && r.data.model) model = r.data.model;
      }
      for (const r of recs) {
        if (r.type !== 'request/header') continue;
        const cfg = r.data && r.data.header && r.data.header.config;
        if (cfg) {
          if (cfg.model) model = cfg.model;
          if (cfg.provider) provider = cfg.provider;
          break;
        }
      }
      const pclass = providerClass(provider);

      // 去重：seq + time + usage 完全相同视为同一条
      const seen = new Set();
      let sessTotal = 0, sessReq = 0, sessCost = 0;
      for (const r of recs) {
        if (r.type !== 'assistant/message') continue;
        const u = r.data && r.data.usage;
        if (!u) continue;
        const key = r.seq + '|' + r.time + '|' + JSON.stringify(u);
        if (seen.has(key)) { stats.deduped++; continue; }
        seen.add(key);

        const uncached = u.inputTokens || 0;
        const cache = u.cacheReadTokens || 0;
        const out = u.outputTokens || 0;
        // 旧日志缺 totalTokens → 自行求和
        const total = u.totalTokens != null ? u.totalTokens : uncached + cache + out;

        // 按北京时间归日（用户在中国；用 UTC 会错位约 30% 的请求）
        const day = new Date(r.time + 8 * 3600 * 1000).toISOString().slice(0, 10);
        const cost = pricing.costOf(r.time, model, uncached, cache, out);
        const peak = pricing.isPeak(r.time);

        const d = byDay[day] || (byDay[day] = emptyDay());
        d.req++; d.uncached += uncached; d.cache += cache; d.out += out; d.total += total;
        d.cost += cost;
        if (pclass === 'official') d.costOfficial += cost;
        else if (pclass === 'ustc') d.costUstc += cost;
        else d.costOther += cost;
        if (peak) { d.peakReq++; d.peakCost += cost; } else { d.offReq++; d.offCost += cost; }

        const depth = (r.data && r.data.delegationDepth) || 0;
        if (depth > 0) { d.subagentReq++; d.subagentTotal += total; }

        const bm = byModel[model] || (byModel[model] = {
          total: 0, req: 0, uncached: 0, cache: 0, out: 0,
          cost: 0, costOfficial: 0, costUstc: 0, costOther: 0
        });
        bm.total += total; bm.req++; bm.uncached += uncached; bm.cache += cache; bm.out += out;
        bm.cost += cost;
        if (pclass === 'official') bm.costOfficial += cost;
        else if (pclass === 'ustc') bm.costUstc += cost;
        else bm.costOther += cost;

        byProviderClass[pclass] = byProviderClass[pclass] || { req: 0, total: 0, cost: 0 };
        byProviderClass[pclass].req++;
        byProviderClass[pclass].total += total;
        byProviderClass[pclass].cost += cost;

        sessTotal += total; sessReq++; sessCost += cost; stats.requests++;
      }
      if (sessReq > 0) perSession.push({ id: uuid, dir: s, ws, model, provider, req: sessReq, total: sessTotal, cost: sessCost });
    }
  }

  // ---- 2. projcache 兜底：补上"进行中、日志未落盘"的会话 ----
  const haveIds = new Set(perSession.map(p => p.id));
  const cacheRoot = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
  if (fs.existsSync(cacheRoot)) {
    for (const f of fs.readdirSync(cacheRoot)) {
      if (!f.endsWith('.json')) continue;
      let j; try { j = JSON.parse(fs.readFileSync(path.join(cacheRoot, f), 'utf8')); } catch { continue; }
      const rec = j.record; if (!rec) continue;
      const tu = rec.rows && rec.rows.tokenUsage && rec.rows.tokenUsage.val;
      if (!tu || !tu.totals) continue;
      // projcache 文件名是裸 UUID（无 session- 前缀），会话目录名有两种约定
      const sid = f.replace(/\.json$/, '').replace(/^session-/, '');
      if (haveIds.has(sid)) continue;   // 已有日志权威数据，跳过
      haveIds.add(sid);

      const t = tu.totals;
      const total = (t.uncachedInputTokens || 0) + (t.cacheReadTokens || 0) +
                    (t.outputTokens || 0) + (t.cacheWriteTokens || 0);
      if (total <= 0) continue;
      // 同样按北京时间归日
      const day = new Date(rec.identity.createdAt + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const d = byDay[day] || (byDay[day] = emptyDay());
      const cost = pricing.costOf(rec.identity.createdAt, 'deepseek-flash',
        t.uncachedInputTokens || 0, t.cacheReadTokens || 0, t.outputTokens || 0);
      d.req++; d.total += total;
      d.uncached += t.uncachedInputTokens || 0;
      d.cache += t.cacheReadTokens || 0;
      d.out += t.outputTokens || 0;
      d.cost += cost;
      // projcache 无 provider 信息，归入 other 以免虚增官方/USTC 分账
      d.costOther += cost;
      if (pricing.isPeak(rec.identity.createdAt)) { d.peakReq++; d.peakCost += cost; }
      else { d.offReq++; d.offCost += cost; }
      perSession.push({ id: sid, ws: '(projcache)', model: 'unknown', provider: 'unknown',
                        req: 1, total, cost, approx: true });
      stats.warnings.push('projcache-only: ' + sid);
    }
  }

  const days = Object.keys(byDay).sort();
  const result = {
    generatedAt: new Date().toISOString(),
    source: sanitizePath(DSH_HOME),
    pricing: {
      currency: 'CNY',
      source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      note: '按 DeepSeek 官方价目表 + 峰谷定价；旧模型名 deepseek-v4-flash* 按 Flash 价；非 DeepSeek 模型按 Flash 价折算',
      peakRule: '北京时间 周一至周五（不含法定节假日）09:00-12:00、14:00-18:00',
      holidays2026: ['2026-09-25', '2026-09-26', '2026-09-27',
                     '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
                     '2026-10-05', '2026-10-06', '2026-10-07'],
      makeupWorkdays: ['2026-09-20', '2026-10-10'],
      table: pricing.PRICES
    },
    stats: { ...stats, days: days.length, firstDay: days[0], lastDay: days[days.length - 1] },
    byProviderClass,
    totals: days.reduce((a, k) => {
      const d = byDay[k];
      a.req += d.req; a.uncached += d.uncached; a.cache += d.cache; a.out += d.out; a.total += d.total;
      a.cost += d.cost; a.costOfficial += d.costOfficial; a.costUstc += d.costUstc; a.costOther += d.costOther;
      a.peakReq += d.peakReq; a.peakCost += d.peakCost; a.offReq += d.offReq; a.offCost += d.offCost;
      return a;
    }, { req: 0, uncached: 0, cache: 0, out: 0, total: 0, cost: 0,
         costOfficial: 0, costUstc: 0, costOther: 0, peakReq: 0, peakCost: 0, offReq: 0, offCost: 0 }),
    byModel,
    daily: days.map(k => ({ day: k, ...byDay[k] })),
    sessions: perSession.sort((a, b) => b.total - a.total)
  };

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

  console.log('DSH 用量采集完成');
  console.log('  会话数   : ' + stats.sessions + ' (v4=' + stats.filesV4 + ', legacy=' + stats.filesLegacy + ')');
  console.log('  请求数   : ' + stats.requests + '  (去重 ' + stats.deduped + ')');
  console.log('  总 token : ' + result.totals.total.toLocaleString());
  console.log('  跨度     : ' + result.stats.firstDay + ' → ' + result.stats.lastDay + ' (' + days.length + ' 天)');
  console.log('  --- 金额（DeepSeek 官方价 + 峰谷）---');
  console.log('  总金额   : ' + yuan(result.totals.cost));
  console.log('    官方   : ' + yuan(result.totals.costOfficial));
  console.log('    USTC   : ' + yuan(result.totals.costUstc));
  console.log('    其它   : ' + yuan(result.totals.costOther));
  console.log('    高峰   : ' + yuan(result.totals.peakCost) + '  (占请求 ' +
    (result.totals.peakReq / result.totals.req * 100).toFixed(1) + '%)');
  console.log('    空闲   : ' + yuan(result.totals.offCost));
  console.log('  输出     : ' + OUT);
  if (stats.warnings.length) console.log('  警告     : ' + stats.warnings.length + ' 条（见 json 的 stats.warnings）');
}

main();
