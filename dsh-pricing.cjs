#!/usr/bin/env node
/**
 * dsh-pricing.cjs — DeepSeek 官方计费引擎（峰谷定价 + 缓存命中/未命中）
 *
 * 官方价目（元 / 百万 tokens）来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *   模型           缓存命中(空闲/高峰)   缓存未命中(空闲/高峰)   输出(空闲/高峰)
 *   deepseek-flash      0.02 / 0.04          1.0 / 2.0           4.0 / 8.0
 *   deepseek-v4-pro     0.15 / 0.30          4.5 / 9.0          13.5 / 27.0
 *   ※ 空闲时段价格 = 高峰时段的一半
 *
 * 峰谷判定（北京时间）：
 *   高峰 = 周一至周五（不含法定节假日）09:00–12:00、14:00–18:00
 *   其余（含周末、法定节假日全天）= 空闲
 *   注：官方英文页写的是 01:00–04:00 / 06:00–10:00 UTC，与北京时间一致。
 *
 * 2026 年法定节假日（国务院办公厅 国办发明电〔2025〕7号）：
 *   中秋 9/25–9/27，国庆 10/1–10/7
 *   调休上班：9/20(周日)、10/10(周六) → 这两天算工作日
 */
'use strict';

// ---- 官方价目表（元 / 1M tokens）----
const PRICES = {
  'deepseek-flash': {
    cacheHit:  { off: 0.02, peak: 0.04 },
    cacheMiss: { off: 1.0,  peak: 2.0  },
    output:    { off: 4.0,  peak: 8.0  }
  },
  'deepseek-v4-pro': {
    cacheHit:  { off: 0.15, peak: 0.30 },
    cacheMiss: { off: 4.5,  peak: 9.0  },
    output:    { off: 13.5, peak: 27.0 }
  }
};

// 旧模型名 → 官方现行计费模型（官方：旧名已下线，按 Flash 价计费）
const MODEL_ALIAS = {
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-flash-ascend': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro'
};

// 非 DeepSeek 官方模型（由第三方网关提供，官方价目表无对应条目）
// 用户要求「全套按 DeepSeek 官方计价」，故这类按 flash 价折算，并在报表中标注。
const NON_DEEPSEEK = new Set(['claude-sonnet-4-6', 'glm-5.3-flash', 'qwen3.8-flash-next-2']);

const FALLBACK_MODEL = 'deepseek-flash';

/** 解析模型名 → 计费模型 id（+ 是否为折算） */
function resolveModel(raw) {
  const m = String(raw || '').toLowerCase().trim();
  if (MODEL_ALIAS[m]) return { bill: MODEL_ALIAS[m], implied: false };
  if (NON_DEEPSEEK.has(m)) return { bill: FALLBACK_MODEL, implied: true };
  // 未知模型：含 'pro' 归 pro，否则归 flash
  if (/pro/.test(m)) return { bill: 'deepseek-v4-pro', implied: true };
  return { bill: FALLBACK_MODEL, implied: true };
}

// ---- 2026 法定节假日（本数据范围内相关部分）----
const HOLIDAYS_2026 = new Set([
  // 中秋
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
  // 本范围外的其它 2026 假期（保持完整，便于跨年复用）
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21'
]);
// 调休上班的周末（算工作日）
const MAKEUP_WORKDAYS = new Set(['2026-09-20', '2026-10-10', '2026-02-14', '2026-02-28', '2026-05-09']);

/** 把毫秒时间戳转为北京时间各字段 */
function beijingParts(ms) {
  const d = new Date(ms + 8 * 3600 * 1000); // UTC+8
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    dow: d.getUTCDay()            // 0=周日
  };
}
const pad2 = n => String(n).padStart(2, '0');

/** 判定某时刻是否高峰时段（北京时间） */
function isPeak(ms) {
  const p = beijingParts(ms);
  const dateStr = p.y + '-' + pad2(p.mo) + '-' + pad2(p.d);
  const isWeekend = p.dow === 0 || p.dow === 6;
  const isWorkday = MAKEUP_WORKDAYS.has(dateStr) ? true
                  : (HOLIDAYS_2026.has(dateStr) ? false : !isWeekend);
  if (!isWorkday) return false;
  // 高峰：09:00–12:00（含 9:00，不含 12:00）、14:00–18:00
  const h = p.h;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 计算单次请求费用（元）。未缓存输入=inputTokens，缓存命中=cacheReadTokens */
function costOf(ms, model, uncached, cacheRead, output) {
  const { bill } = resolveModel(model);
  const P = PRICES[bill];
  const band = isPeak(ms) ? 'peak' : 'off';
  const c = (uncached / 1e6) * P.cacheMiss[band]
          + (cacheRead / 1e6) * P.cacheHit[band]
          + (output   / 1e6) * P.output[band];
  return c;
}

module.exports = { PRICES, MODEL_ALIAS, NON_DEEPSEEK, resolveModel, isPeak, costOf, HOLIDAYS_2026, MAKEUP_WORKDAYS };
