#!/usr/bin/env node
/**
 * dsh-usage-report.cjs — 由 dsh-usage-daily.json 生成单文件 HTML 报表
 *
 * 用法：node dsh-usage-report.cjs [输入json] [输出html]
 * 特性：ECharts 从 CDN 加载（离线时图不显示，表格仍可用）；口径可切换；点击日期下钻
 */
'use strict';
const fs = require('fs');
const path = require('path');

const IN = process.argv[2] || path.join(__dirname, 'dsh-usage-daily.json');
const OUT = process.argv[3] || path.join(__dirname, 'DSH用量报表.html');

const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
const fmt = n => n.toLocaleString('en-US');
const isDemo = !!data.demo;

// 中文单位：万 / 亿（用户要求，不使用 M / B）
function M(n) {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (a >= 1e4) return (n / 1e4).toFixed(2) + ' 万';
  return String(Math.round(n));
}
// 金额
const yuan = n => '¥' + (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));

const t = data.totals;
const days = data.daily;
const nDays = days.length;
const avg = t.total / nDays;
const avgCost = t.cost / nDays;
const peak = days.reduce((a, b) => (b.total > a.total ? b : a), days[0]);
const peakCostDay = days.reduce((a, b) => ((b.cost || 0) > (a.cost || 0) ? b : a), days[0]);
const cacheHit = t.cache / (t.cache + t.uncached) * 100;
// 平均单价（元/百万 tokens）
const unitPrice = t.cost / (t.total / 1e6);
const baselineNoCache = (t.cache / 1e6) * 2 + (t.uncached / 1e6) * 2 + (t.out / 1e6) * 8;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH Token 用量报表${isDemo ? '（示例数据）' : ''}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
<style>
  :root { --bg:#0f1116; --card:#181b22; --line:#272b34; --fg:#e6e8ee; --dim:#8b93a7; --acc:#4f8cff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:20px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .k { color:var(--dim); font-size:12px; margin-bottom:6px; }
  .card .v { font-size:22px; font-weight:600; letter-spacing:-.5px; }
  .card .n { color:var(--dim); font-size:11px; margin-top:4px; }
  .card.hl { border-color:#3a5a9a; background:linear-gradient(180deg,#1b2333,#181b22); }
  .card.hl .v { color:#8ab4ff; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  .panel h2 { font-size:14px; margin:0 0 2px; font-weight:600; }
  .panel .hint { color:var(--dim); font-size:12px; margin-bottom:12px; }
  .chart { width:100%; }
  #main { height:360px; } #out { height:240px; } #heat { height:180px; }
  .toolbar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  button { background:#202531; color:var(--fg); border:1px solid var(--line);
           border-radius:7px; padding:6px 13px; font-size:13px; cursor:pointer; }
  button:hover { border-color:var(--acc); }
  button.on { background:var(--acc); border-color:var(--acc); color:#fff; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { padding:7px 10px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap; }
  th:first-child,td:first-child { text-align:left; }
  th { color:var(--dim); font-weight:500; cursor:pointer; user-select:none; }
  th:hover { color:var(--fg); }
  tbody tr:hover { background:#1e222b; }
  .bar { height:8px; background:var(--acc); border-radius:2px; display:inline-block; vertical-align:middle; }
  .note { color:var(--dim); font-size:12px; margin-top:10px; }
  .demo-banner { background:#3a2f14; border:1px solid #7a6420; color:#ffd479;
                 border-radius:10px; padding:12px 16px; margin:0 0 16px; font-size:13px; line-height:1.6; }
  .demo-banner code { background:#00000040; padding:2px 6px; border-radius:4px; }
  .legend { display:flex; gap:16px; font-size:12px; color:var(--dim); margin-bottom:8px; flex-wrap:wrap; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  select { background:#202531; color:var(--fg); border:1px solid var(--line); border-radius:7px; padding:6px 10px; }
</style>
</head>
<body>
  <h1>DSH Token 用量报表</h1>
  ${isDemo ? `<div class="demo-banner">⚠ 这是<b>示例报表</b>：数据为程序合成的演示数据，<b>不含任何真实用量</b>。<br>
    想生成你自己的报表：<code>node dsh-usage-collect.cjs &amp;&amp; node dsh-usage-report.cjs</code></div>` : ''}
  <div class="sub">数据源 ${data.source}　·　生成于 ${new Date(data.generatedAt).toLocaleString('zh-CN')}　·　${data.stats.firstDay} → ${data.stats.lastDay}（${nDays} 天${data.stats.sessions ? '，含 ' + data.stats.sessions + ' 个会话' : ''}）</div>

  <div class="cards">
    <div class="card hl"><div class="k">总金额（官方价折算）</div><div class="v">${yuan(t.cost)}</div><div class="n">官方 ${yuan(t.costOfficial)} · USTC ${yuan(t.costUstc)}</div></div>
    <div class="card"><div class="k">总 Token</div><div class="v">${M(t.total)}</div><div class="n">${fmt(t.total)}</div></div>
    <div class="card"><div class="k">日均</div><div class="v">${M(avg)}</div><div class="n">${yuan(avgCost)} / 天</div></div>
    <div class="card"><div class="k">峰值日</div><div class="v">${M(peak.total)}</div><div class="n">${peak.day} · ${yuan(peakCostDay.cost)}</div></div>
    <div class="card"><div class="k">请求数</div><div class="v">${fmt(t.req)}</div><div class="n">≈ ${Math.round(t.req / nDays)}/天</div></div>
    <div class="card"><div class="k">缓存命中率</div><div class="v">${cacheHit.toFixed(1)}%</div><div class="n">平均 ${unitPrice.toFixed(2)} 元/百万</div></div>
  </div>

  <div class="panel">
    <h2>费用概览</h2>
    <div class="hint">按 DeepSeek 官方价目表 + 峰谷定价计算；可切换统计范围</div>
    <div class="toolbar">
      <button data-scope="all" class="on">全部（含 USTC 折算）</button>
      <button data-scope="official">仅 DeepSeek 官方</button>
      <button data-scope="ustc">仅 USTC</button>
    </div>
    <div class="cards" id="costCards"></div>
    <div class="chart" id="cost" style="height:300px"></div>
    <div class="legend">
      <span><span class="dot" style="background:#4f8cff"></span>官方</span>
      <span><span class="dot" style="background:#a06bff"></span>USTC</span>
      <span><span class="dot" style="background:#ffb020"></span>高峰时段费用</span>
    </div>
  </div>

  <div class="panel">
    <h2>每日用量</h2>
    <div class="hint">堆叠展示构成；缓存读通常占绝大多数，可切换口径查看</div>
    <div class="toolbar">
      <button data-metric="total" class="on">总量</button>
      <button data-metric="cost">金额</button>
      <button data-metric="out">输出量</button>
      <button data-metric="req">请求数</button>
      <span style="flex:1"></span>
      <button id="tgType">切换 柱状 / 折线</button>
      <button id="tgLog">对数轴</button>
    </div>
    <div class="chart" id="main"></div>
  </div>

  <div class="panel">
    <h2>输出 Token（真实产出）</h2>
    <div class="hint">与上图共用 x 轴。单独成图以避免被缓存量级淹没</div>
    <div class="chart" id="out"></div>
  </div>

  <div class="panel">
    <h2>活跃热力图</h2>
    <div class="hint">按周排布，颜色深浅 = 当日总量</div>
    <div class="chart" id="heat"></div>
  </div>

  <div class="panel">
    <h2>明细</h2>
    <div class="hint">点击表头排序</div>
    <table id="tbl">
      <thead><tr>
        <th data-s="day">日期</th><th data-s="req">请求数</th>
        <th data-s="total">总 Token</th><th data-s="cost">金额</th>
        <th data-s="cache">缓存读</th>
        <th data-s="uncached">未缓存输入</th><th data-s="out">输出</th>
        <th data-s="cache">命中率</th><th>占比</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="panel">
    <h2>按网关</h2>
    <div class="hint">DeepSeek 官方端点 vs USTC 网关（金额均为按官方价折算）</div>
    <table id="ptbl"><thead><tr><th>网关</th><th>请求数</th><th>总 Token</th><th>金额</th><th>金额占比</th></tr></thead><tbody></tbody></table>
  </div>

  <div class="panel">
    <h2>按模型</h2>
    <table id="mtbl"><thead><tr><th>模型</th><th>请求数</th><th>总 Token</th><th>金额</th><th>金额占比</th><th>Token 占比</th></tr></thead><tbody></tbody></table>
  </div>

  <div class="panel">
    <h2>计价规则</h2>
    <table>
      <thead><tr><th>项目</th><th>值</th></tr></thead>
      <tbody>
        <tr><td>价目来源</td><td style="text-align:left"><a href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing/" style="color:#8ab4ff">DeepSeek 官方文档</a></td></tr>
        <tr><td>高峰时段</td><td style="text-align:left">${(data.pricing && data.pricing.peakRule) || '北京时间 周一至周五（不含法定节假日）09:00-12:00、14:00-18:00'}</td></tr>
        <tr><td>空闲时段</td><td style="text-align:left">其余时段（含周末、法定节假日全天），单价为高峰的 <b>50%</b></td></tr>
        <tr><td>法定节假日</td><td style="text-align:left">中秋 9/25–9/27、国庆 10/1–10/7（2026 国务院安排）</td></tr>
        <tr><td>调休上班</td><td style="text-align:left">9/20(周日)、10/10(周六) 按工作日计</td></tr>
        <tr><td>flash 单价（空闲/高峰）</td><td style="text-align:left">缓存命中 0.02/0.04 · 未命中 1/2 · 输出 4/8（元/百万）</td></tr>
        <tr><td>v4-pro 单价（空闲/高峰）</td><td style="text-align:left">缓存命中 0.15/0.30 · 未命中 4.5/9.0 · 输出 13.5/27.0（元/百万）</td></tr>
      </tbody>
    </table>
  </div>

  <div class="note">
    <b>口径说明</b><br>
    · 金额 = ∑(token × 对应时段单价)。<b>未缓存输入</b>=cache miss，<b>缓存读</b>=cache hit。<br>
    · 旧模型名 <code>deepseek-v4-flash*</code> 按官方说明<b>按 Flash 价</b>计费；非 DeepSeek 模型按 Flash 价折算并已标注。<br>
    · <b>本金额是「按官方价折算」的参考值</b>：你 63% 的流量走 USTC 网关，实际不由 DeepSeek 计费。可用上方按钮切到「仅 DeepSeek 官方」看真实口径。<br>
    · 官方保留调价权利，历史单价可能与本表不同，故该金额为估算。
  </div>

<script>
const DATA = ${JSON.stringify({
  days, byModel: data.byModel, byProviderClass: data.byProviderClass || {},
  totals: t, pricing: data.pricing || {}
})};
const fmt = n => n.toLocaleString('en-US');
// 中文单位：万 / 亿
const M = n => { const a = Math.abs(n); return a>=1e8?(n/1e8).toFixed(2)+' 亿':a>=1e4?(n/1e4).toFixed(2)+' 万':String(Math.round(n)); };
const yuan = n => '¥' + (Math.abs(n)>=1000 ? Math.round(n).toLocaleString('en-US') : (n||0).toFixed(2));

// 统计范围切换：all(默认) / official / ustc
let scope = 'all';
function scopeDays() {
  return DATA.days.map(d => {
    if (scope === 'official') {
      const share = d.cost > 0 ? d.costOfficial / d.cost : 0;
      return Object.assign({}, d, { cost: d.costOfficial, _tok: d.total * share });
    }
    if (scope === 'ustc') {
      const share = d.cost > 0 ? d.costUstc / d.cost : 0;
      return Object.assign({}, d, { cost: d.costUstc, _tok: d.total * share });
    }
    return Object.assign({}, d, { cost: d.cost, _tok: d.total });
  });
}
function scopeTotals() {
  const ds = scopeDays();
  return ds.reduce((a, d) => { a.cost += d.cost; a.peakCost += (scope==='all'?d.peakCost:0);
    a.offCost += (scope==='all'?d.offCost:0); a.req += d.req; return a; },
    { cost:0, peakCost:0, offCost:0, req:0 });
}

const lbl = DATA.days.map(d => d.day.slice(5));
let metric = 'total', isLine = false, isLog = false;

const themed = { textStyle:{ color:'#e6e8ee' },
  grid:{ left:56, right:20, top:28, bottom:34 },
  tooltip:{ trigger:'axis', backgroundColor:'#181b22', borderColor:'#272b34',
            textStyle:{ color:'#e6e8ee', fontSize:12 },
            formatter: ps => {
              if (!ps || !ps.length) return '';
              const d0 = DATA.days[ps[0].dataIndex];
              let s = '<b>' + d0.day + '</b><br>' + fmt(d0.req) + ' 次请求';
              ps.forEach(p => { if (p.value != null) s += '<br>' + p.marker + p.seriesName + '：' + fmt(p.value); });
              return s;
            } },
  xAxis:{ type:'category', data:lbl, axisLine:{ lineStyle:{ color:'#272b34' } },
          axisLabel:{ color:'#8b93a7' } },
  yAxis:{ type:'value', axisLine:{ show:false }, splitLine:{ lineStyle:{ color:'#1e222b' } },
          axisLabel:{ color:'#8b93a7', formatter: v => v >= 1e6 ? M(v) : fmt(v) } } };

function series() {
  if (metric === 'req') {
    return [{ name:'请求数', type:isLine?'line':'bar', data:DATA.days.map(d=>d.req),
              itemStyle:{ color:'#4f8cff' }, smooth:true, areaStyle:isLine?{opacity:.15}:null }];
  }
  if (metric === 'out') {
    return [{ name:'输出', type:isLine?'line':'bar', stack:isLine?null:'s',
              data:DATA.days.map(d=>d.out), itemStyle:{ color:'#37d399' },
              smooth:true, areaStyle:isLine?{opacity:.15}:null }];
  }
  if (metric === 'cost') {
    return [{ name:'金额', type:isLine?'line':'bar', data:DATA.days.map(d => +d.cost.toFixed(4)),
              itemStyle:{ color:'#ffb020' }, smooth:true, areaStyle:isLine?{opacity:.15}:null }];
  }
  return [
    { name:'未缓存输入', type:isLine?'line':'bar', stack:'s', data:DATA.days.map(d=>d.uncached), itemStyle:{ color:'#ffb020' } },
    { name:'缓存读', type:isLine?'line':'bar', stack:'s', data:DATA.days.map(d=>d.cache), itemStyle:{ color:'#4f8cff' } },
    { name:'输出', type:isLine?'line':'bar', stack:'s', data:DATA.days.map(d=>d.out), itemStyle:{ color:'#37d399' } }
  ];
}

const cMain = echarts.init(document.getElementById('main'), null, { renderer:'canvas' });
function drawMain() {
  const s = series();
  const showLegend = metric === 'total';
  // 金额图用"元"轴标签；token 图用短中文单位，避免标签被截断
  const yAxis = Object.assign({}, themed.yAxis, {
    type: isLog ? 'log' : 'value',
    axisLabel: { color:'#8b93a7', hideOverlap:true,
      formatter: v => metric === 'cost' ? ('¥' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v))
                     : AX(v) }
  });
  cMain.setOption(Object.assign({}, themed, {
    color: s.map(x => x.itemStyle.color),
    legend: showLegend ? { textStyle:{ color:'#8b93a7' }, top:0, right:0 } : { show:false },
    yAxis: yAxis,
    series: s
  }), true);
}
drawMain();

// ---- 费用图 + 卡片（受 scope 影响）----
const cCost = echarts.init(document.getElementById('cost'), null, { renderer:'canvas' });
function drawCost() {
  const ds = scopeDays();
  const st = scopeTotals();
  const official = DATA.totals.costOfficial || 0;
  const ustc = DATA.totals.costUstc || 0;
  const other = DATA.totals.costOther || 0;
  const shown = scope === 'official' ? official : scope === 'ustc' ? ustc : st.cost;
  const tok = scope === 'all' ? DATA.totals.total
            : (DATA.totals.total * (shown / (DATA.totals.cost || 1)));
  const cards = [
    ['金额合计', yuan(shown), scope === 'all' ? '官方+USTC+其它' : (scope === 'official' ? '仅 DeepSeek 官方' : '仅 USTC 网关')],
    ['日均', yuan(shown / ds.length), '按 ' + ds.length + ' 天'],
    ['平均单价', '¥' + (shown / (tok / 1e6)).toFixed(2), '元 / 百万 tokens'],
    ['高峰费用', scope === 'all' ? yuan(st.peakCost) : '—', scope === 'all' ? ('占 ' + (st.peakCost / (st.cost || 1) * 100).toFixed(1) + '%') : '仅全部范围'],
    ['空闲费用', scope === 'all' ? yuan(st.offCost) : '—', scope === 'all' ? ('占 ' + (st.offCost / (st.cost || 1) * 100).toFixed(1) + '%') : '仅全部范围']
  ];
  document.getElementById('costCards').innerHTML = cards.map((c, i) =>
    '<div class="card' + (i === 0 ? ' hl' : '') + '"><div class="k">' + c[0] + '</div><div class="v">' +
    c[1] + '</div><div class="n">' + c[2] + '</div></div>').join('');

  cCost.setOption(Object.assign({}, themed, {
    tooltip:{ trigger:'axis', backgroundColor:'#181b22', borderColor:'#272b34', textStyle:{color:'#e6e8ee'},
      formatter: ps => {
        if (!ps || !ps.length) return '';
        const d0 = DATA.days[ps[0].dataIndex];
        let s = '<b>' + d0.day + '</b><br>合计 ' + yuan(d0.cost) +
                '<br>官方 ' + yuan(d0.costOfficial) + '<br>USTC ' + yuan(d0.costUstc) +
                '<br>高峰 ' + yuan(d0.peakCost) + ' / 空闲 ' + yuan(d0.offCost) +
                '<br>平均单价 ¥' + (d0.cost / (d0.total / 1e6)).toFixed(2) + '/百万';
        return s;
      } },
    legend:{ textStyle:{ color:'#8b93a7' }, top:0, right:0 },
    grid:{ left:64, right:20, top:28, bottom:34 },
    xAxis: Object.assign({}, themed.xAxis),
    yAxis: Object.assign({}, themed.yAxis, { axisLabel:{ color:'#8b93a7', formatter: v => '¥' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0)) } }),
    series:[
      { name:'官方', type:'bar', stack:'c', data: ds.map(d => scope === 'ustc' ? 0 : +d.costOfficial.toFixed(4)), itemStyle:{ color:'#4f8cff' } },
      { name:'USTC', type:'bar', stack:'c', data: ds.map(d => scope === 'official' ? 0 : +d.costUstc.toFixed(4)), itemStyle:{ color:'#a06bff' } },
      { name:'高峰时段费用', type:'line', smooth:true, symbol:'none',
        data: ds.map(d => scope === 'all' ? +d.peakCost.toFixed(4) : null),
        itemStyle:{ color:'#ffb020' }, lineStyle:{ width:1.5, type:'dashed' } }
    ]
  }), true);
}
drawCost();

// scope 按钮
document.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-scope]').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); scope = b.dataset.scope; drawCost();
});

// 轴标签专用的短单位（避免标签过长被截断）
function AX(n) {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (a >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(Math.round(n));
}

// ---- 输出量小图 ----
const cOut = echarts.init(document.getElementById('out'), null, { renderer:'canvas' });
cOut.setOption(Object.assign({}, themed, {
  grid:{ left:64, right:24, top:16, bottom:34 },
  tooltip:{ trigger:'axis', backgroundColor:'#181b22', borderColor:'#272b34', textStyle:{color:'#e6e8ee'},
    formatter: ps => {
      if (!ps || !ps.length) return '';
      const d0 = DATA.days[ps[0].dataIndex];
      return '<b>' + d0.day + '</b><br>输出 ' + fmt(d0.out) + ' tokens (' + M(d0.out) + ')';
    } },
  yAxis: Object.assign({}, themed.yAxis, {
    axisLabel: { color:'#8b93a7', formatter: v => AX(v), hideOverlap:true } }),
  series:[{ name:'输出', type:'line', smooth:true, data:DATA.days.map(d=>d.out),
            itemStyle:{ color:'#37d399' }, areaStyle:{ opacity:.18 } }]
}));

// 热力图：列 = 自然周（周一为起点），行 = 星期几
const DAY0 = new Date(DATA.days[0].day + 'T00:00:00');
const mondayOf = dt => { const x = new Date(dt); const w = (x.getDay() + 6) % 7; x.setDate(x.getDate() - w); x.setHours(0,0,0,0); return x; };
const week0 = mondayOf(DAY0);
const weekOf = dt => Math.round((mondayOf(dt) - week0) / 86400000 / 7);
const rowOf  = dt => (dt.getDay() + 6) % 7;          // 0=周一 … 6=周日
const maxWk  = weekOf(new Date(DATA.days[DATA.days.length - 1].day + 'T00:00:00'));
const heat = DATA.days.map(d => {
  const dt = new Date(d.day + 'T00:00:00');
  return [ weekOf(dt), rowOf(dt), d.total ];
});
const heatIndex = {};
DATA.days.forEach(d => { const dt = new Date(d.day + 'T00:00:00'); heatIndex[weekOf(dt) + ':' + rowOf(dt)] = d; });
const cHeat = echarts.init(document.getElementById('heat'), null, { renderer:'canvas' });
cHeat.setOption({
  tooltip:{ backgroundColor:'#181b22', borderColor:'#272b34', textStyle:{color:'#e6e8ee'},
    formatter: p => {
      const dd = heatIndex[p.value[0] + ':' + p.value[1]];
      return dd ? dd.day + '<br>' + fmt(dd.total) + ' tokens<br>' + fmt(dd.req) + ' 次请求' : '无用量';
    } },
  grid:{ left:52, right:16, top:8, bottom:26 },
  xAxis:{ type:'category', data:Array.from({length:maxWk+1},(_,i)=>'W'+(i+1)),
          axisLabel:{ color:'#8b93a7' }, axisLine:{ lineStyle:{color:'#272b34'} },
          splitLine:{ show:false }, splitArea:{show:false} },
  yAxis:{ type:'category', data:['一','二','三','四','五','六','日'],
          axisLabel:{ color:'#8b93a7' }, axisLine:{ lineStyle:{color:'#272b34'} } },
  visualMap:{ min:0, max:Math.max(...DATA.days.map(d=>d.total)), show:false,
              inRange:{ color:['#1b2130','#2b4a8a','#4f8cff','#8ab4ff'] } },
  series:[{ type:'heatmap', data:heat,
            itemStyle:{ borderColor:'#0f1116', borderWidth:2, borderRadius:3 },
            label:{ show:false }, progressive:0 }]
});

// 交互
document.querySelectorAll('[data-metric]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-metric]').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); metric = b.dataset.metric; drawMain();
});
document.getElementById('tgType').onclick = e => { isLine = !isLine; e.target.classList.toggle('on', isLine); drawMain(); };
document.getElementById('tgLog').onclick = e => { isLog = !isLog; e.target.classList.toggle('on', isLog); drawMain(); };

// 表格
let sortKey = 'day', sortAsc = true;
function renderTable() {
  const rows = DATA.days.slice().sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return sortAsc ? c : -c;
  });
  const max = Math.max(...DATA.days.map(d => d.total));
  document.querySelector('#tbl tbody').innerHTML = rows.map(d => {
    const hit = (d.cache + d.uncached) > 0 ? (d.cache / (d.cache + d.uncached) * 100) : 0;
    const w = Math.max(2, d.total / max * 70);
    const up = d.total > 0 ? (d.cost / (d.total / 1e6)) : 0;
    return '<tr><td>' + d.day + '</td><td>' + fmt(d.req) + '</td><td>' + fmt(d.total) + '</td>' +
      '<td title="平均 ¥' + up.toFixed(2) + '/百万">' + yuan(d.cost) + '</td><td>' +
      fmt(d.cache) + '</td><td>' + fmt(d.uncached) + '</td><td>' + fmt(d.out) + '</td><td>' +
      hit.toFixed(1) + '%</td><td><span class="bar" style="width:' + w + 'px"></span></td></tr>';
  }).join('');
}
document.querySelectorAll('#tbl th').forEach(th => th.onclick = () => {
  const k = th.dataset.s;
  if (k === sortKey) sortAsc = !sortAsc; else { sortKey = k; sortAsc = k === 'day'; }
  renderTable();
});
renderTable();

const mEntries = Object.entries(DATA.byModel)
  .map(([k, v]) => [k, (typeof v === 'number' ? { total: v, cost: 0, req: 0 } : v)])
  .sort((a, b) => b[1].total - a[1].total);
const mTotal = mEntries.reduce((a, b) => a + b[1].total, 0);
const mCost = mEntries.reduce((a, b) => a + (b[1].cost || 0), 0);
document.querySelector('#mtbl tbody').innerHTML = mEntries.map(([k, v]) =>
  '<tr><td>' + k + '</td><td>' + fmt(v.req || 0) + '</td><td>' + fmt(v.total) + '</td>' +
  '<td>' + yuan(v.cost || 0) + '</td><td>' + ((v.cost || 0) / (mCost || 1) * 100).toFixed(2) + '%</td>' +
  '<td>' + (v.total / mTotal * 100).toFixed(2) + '%</td></tr>').join('');

// 按网关
const pc = DATA.byProviderClass || {};
const pcName = { official: 'DeepSeek 官方', ustc: 'USTC 网关', other: '其它' };
const pcTotal = Object.values(pc).reduce((a, b) => a + b.cost, 0);
document.querySelector('#ptbl tbody').innerHTML = Object.entries(pc)
  .sort((a, b) => b[1].cost - a[1].cost)
  .map(([k, v]) => '<tr><td>' + (pcName[k] || k) + '</td><td>' + fmt(v.req) + '</td><td>' +
    fmt(v.total) + '</td><td>' + yuan(v.cost) + '</td><td>' + (v.cost / (pcTotal || 1) * 100).toFixed(2) + '%</td></tr>').join('');

window.addEventListener('resize', () => { cMain.resize(); cOut.resize(); cHeat.resize(); cCost.resize(); });
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('报表已生成: ' + OUT + (isDemo ? '   [示例数据]' : ''));
console.log('  天数 ' + nDays + ' | 总 token ' + fmt(t.total) + ' (' + M(t.total) + ')');
console.log('  金额 ' + yuan(t.cost) + '  (官方 ' + yuan(t.costOfficial) + ' + USTC ' + yuan(t.costUstc) + ')');
console.log('  峰值日 ' + peak.day);
