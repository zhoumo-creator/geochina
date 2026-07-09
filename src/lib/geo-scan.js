/**
 * GEO 扫描核心模块（服务端）
 * 移植自 geo-agent/geo-scanner.js v0.1，为 geochina.co 在线扫描改造：
 * - 双轨评分：中文 AI 引擎就绪度 + 海外 AI 引擎就绪度
 * - 新增：中文引擎关联爬虫检查、llms.txt、SSR 启发式检测
 * - 输出 JSON（由前端渲染），支持 zh / en 双语（scanSite 第二参数）
 */

import { load } from 'cheerio';

// ─── 爬虫清单 ─────────────────────────────────────────
// 中文 AI 引擎与其内容获取通道的关联爬虫。
// 注意：Bytespider 在出海视角常被建议屏蔽（训练爬虫），
// 但屏蔽它等于把豆包生态挡在门外——这是中文 GEO 与出海 GEO 打法相反的地方。
const CN_CRAWLERS = [
  {
    name: 'Bytespider',
    engine: { zh: '豆包', en: 'Doubao' },
    desc: { zh: '字节跳动（豆包/头条搜索生态）', en: 'ByteDance (Doubao / Toutiao search ecosystem)' },
  },
  {
    name: 'Baiduspider',
    engine: { zh: '文心一言', en: 'ERNIE Bot' },
    desc: { zh: '百度搜索（文心的检索底座）', en: 'Baidu Search (retrieval layer behind ERNIE)' },
  },
  {
    name: 'Sogou web spider',
    key: 'sogou',
    engine: { zh: '腾讯元宝', en: 'Tencent Yuanbao' },
    desc: { zh: '搜狗（元宝/微信搜一搜生态）', en: 'Sogou (Yuanbao / WeChat Search ecosystem)' },
  },
  {
    name: 'YisouSpider',
    engine: { zh: '通义/夸克', en: 'Qwen / Quark' },
    desc: { zh: '神马搜索（阿里系检索通道）', en: 'Shenma Search (Alibaba retrieval channel)' },
  },
  {
    name: '360Spider',
    engine: { zh: '360 AI 搜索', en: '360 AI Search' },
    desc: { zh: '360 搜索', en: '360 Search' },
  },
];

const GLOBAL_CRAWLERS = [
  { name: 'GPTBot', engine: { zh: 'ChatGPT', en: 'ChatGPT' }, desc: { zh: 'OpenAI 索引', en: 'OpenAI indexing' } },
  { name: 'OAI-SearchBot', engine: { zh: 'ChatGPT Search', en: 'ChatGPT Search' }, desc: { zh: 'OpenAI 搜索', en: 'OpenAI search' } },
  { name: 'PerplexityBot', engine: { zh: 'Perplexity', en: 'Perplexity' }, desc: { zh: 'Perplexity AI', en: 'Perplexity AI' } },
  { name: 'ClaudeBot', engine: { zh: 'Claude', en: 'Claude' }, desc: { zh: 'Anthropic', en: 'Anthropic' } },
  { name: 'Google-Extended', engine: { zh: 'Gemini / AIO', en: 'Gemini / AIO' }, desc: { zh: 'Google AI', en: 'Google AI' } },
];

const CITATION_TRIGGERS = [
  { key: 'comparison_tables', label: { zh: '对比表格', en: 'Comparison tables' }, stars: 5 },
  { key: 'pricing_data', label: { zh: '价格数据', en: 'Pricing data' }, stars: 5 },
  { key: 'percentage_stats', label: { zh: '数据统计', en: 'Statistics & percentages' }, stars: 4 },
  { key: 'step_by_step', label: { zh: '步骤指南', en: 'Step-by-step guides' }, stars: 4 },
  { key: 'comparisons', label: { zh: '对比内容', en: 'Comparison content' }, stars: 4 },
  { key: 'year_references', label: { zh: '年份标记', en: 'Year references' }, stars: 3 },
  { key: 'definitions', label: { zh: '定义型内容', en: 'Definition-style content' }, stars: 4 },
];

// ─── 抓取 ─────────────────────────────────────────────

const BLOCKED_HOST_RE = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/i;

export function normalizeUrl(input) {
  let url = String(input || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (BLOCKED_HOST_RE.test(u.hostname) || !u.hostname.includes('.')) return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function fetchSafe(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GEOChina-Scanner/1.0; +https://geochina.co/scan)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    clearTimeout(timer);
    const body = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, body: '', error: e.message };
  }
}

// ─── robots.txt 分析 ──────────────────────────────────

function parseRobots(robotsBody) {
  const rules = {};
  let current = [];
  for (const line of robotsBody.split('\n')) {
    const t = line.trim().toLowerCase();
    if (t.startsWith('user-agent:')) {
      const agent = t.replace('user-agent:', '').trim();
      if (!rules[agent]) rules[agent] = [];
      current = rules[agent];
    } else if (t.startsWith('allow:') || t.startsWith('disallow:')) {
      current.push(t);
    }
  }
  return rules;
}

function crawlerStatus(rules, crawler) {
  const key = (crawler.key || crawler.name).toLowerCase();
  const matched = Object.keys(rules).find((a) => a.includes(key) || key.includes(a) && a !== '*');
  const agentRules = matched ? rules[matched] : null;
  if (agentRules) {
    const blockedAll = agentRules.some((r) => r.startsWith('disallow:') && r.replace('disallow:', '').trim() === '/');
    if (blockedAll) return 'blocked';
    return 'allowed';
  }
  if (rules['*']) {
    const wildcardBlockAll = rules['*'].some((r) => r.startsWith('disallow:') && r.replace('disallow:', '').trim() === '/');
    return wildcardBlockAll ? 'blocked' : 'default_allowed';
  }
  return 'default_allowed'; // 无 robots.txt 或未提及 = 默认放行
}

function analyzeRobots(robotsBody, lang) {
  const exists = robotsBody.length > 0;
  const rules = exists ? parseRobots(robotsBody) : {};
  const check = (list) =>
    list.map((c) => ({
      name: c.name,
      engine: c.engine[lang],
      desc: c.desc[lang],
      status: exists ? crawlerStatus(rules, c) : 'default_allowed',
    }));
  return {
    exists,
    hasSitemapRef: exists && robotsBody.toLowerCase().includes('sitemap:'),
    cn: check(CN_CRAWLERS),
    global: check(GLOBAL_CRAWLERS),
  };
}

// ─── 页面分析 ─────────────────────────────────────────

function analyzePage(html) {
  const $ = load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const bodyLower = bodyText.toLowerCase();

  // 语言信号（全文采样，首屏常被英文品牌词占据导致误判）
  const cjk = (bodyText.match(/[一-鿿]/g) || []).length;
  const total = bodyText.replace(/\s/g, '').length;
  const cjkRatio = total > 0 ? cjk / total : 0;

  // SSR 启发式：正文文本极少 + 存在空挂载点 → 疑似纯客户端渲染。
  // AI 引擎的爬虫基本不执行 JS，纯 CSR 站对它们等于空白页。
  const mountEmpty = ['#root', '#app', '#__next'].some((sel) => {
    const el = $(sel);
    return el.length > 0 && el.text().trim().length < 50;
  });
  const likelyCSR = bodyText.length < 200 || mountEmpty;

  const schemaTypes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const t = data['@type'] || (Array.isArray(data['@graph']) ? data['@graph'].map((g) => g['@type']).join(', ') : null);
      if (t) schemaTypes.push(String(t));
    } catch { /* 忽略格式错误的 JSON-LD */ }
  });

  const triggers = [];
  if ($('table').length > 0 && $('table td').length > 4) triggers.push('comparison_tables');
  if (bodyLower.match(/[$¥￥]\s?\d+|\d+\s?元/)) triggers.push('pricing_data');
  if (bodyLower.match(/\d+(\.\d+)?%/)) triggers.push('percentage_stats');
  if (bodyLower.match(/step \d|步骤\s?\d|第[一二三四五六七八九十]步/i)) triggers.push('step_by_step');
  if (bodyLower.match(/\bvs\.?\b|versus|对比|比较/i)) triggers.push('comparisons');
  if (bodyLower.match(/202[5-9]/)) triggers.push('year_references');
  if (bodyLower.match(/what is|什么是|是指|指的是/i)) triggers.push('definitions');

  const updatePatterns = ['updated', 'last updated', '更新时间', '最后更新', '更新于'];

  return {
    title: $('title').text().trim(),
    metaDescription: $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '',
    h1: $('h1').first().text().trim(),
    h1Count: $('h1').length,
    hasCanonical: $('link[rel="canonical"]').length > 0,
    lang: $('html').attr('lang') || '',
    hreflangCount: $('link[rel="alternate"][hreflang]').length,
    schemaTypes,
    cjkRatio,
    likelyCSR,
    wordCount: bodyText.split(/\s+/).length,
    hasUpdateTimestamp: updatePatterns.some((p) => bodyLower.includes(p)),
    triggers,
    faqSignal: /faq|常见问题/i.test(bodyLower),
  };
}

function analyzeSitemap(xml) {
  const exists = xml.length > 0 && (xml.includes('<url>') || xml.includes('<sitemap>'));
  if (!exists) return { exists: false, urlCount: 0, hasLastmod: false };
  const urlCount = (xml.match(/<loc>/g) || []).length;
  return { exists: true, urlCount, hasLastmod: xml.includes('<lastmod>') };
}

// ─── 评分 ─────────────────────────────────────────────

function allowedRatio(crawlers) {
  const ok = crawlers.filter((c) => c.status === 'allowed' || c.status === 'default_allowed').length;
  return ok / crawlers.length;
}

function scoreCommon(page, sitemap, robots) {
  let s = 0;
  s += page.title.length > 10 ? 8 : 0;
  s += page.metaDescription.length > 50 ? 8 : 0;
  s += page.h1Count === 1 ? 6 : page.h1Count > 0 ? 3 : 0;
  s += page.hasCanonical ? 4 : 0;
  s += Math.min(page.schemaTypes.length * 8, 16);
  s += page.likelyCSR ? 0 : 18; // SSR 是硬门槛
  s += page.hasUpdateTimestamp ? 6 : 0;
  s += (page.triggers.length / CITATION_TRIGGERS.length) * 22;
  s += sitemap.exists ? 6 : 0;
  s += robots.hasSitemapRef ? 3 : 0;
  s += sitemap.hasLastmod ? 3 : 0;
  return s; // 满分 100
}

// ─── 建议生成（双语文案） ─────────────────────────────

const ACTION_TEXT = {
  zh: {
    cnBlocked: (names, engines) => ({
      title: `解除对中文引擎爬虫的屏蔽：${names.join('、')}`,
      why: `这直接影响 ${engines.join('、')} 能否收录你的内容。注意：出海教程常建议屏蔽 Bytespider，但做中文市场恰恰要放行它（豆包生态）。`,
    }),
    csr: {
      title: '页面疑似纯客户端渲染（CSR），改为服务端渲染或预渲染',
      why: 'AI 引擎的爬虫基本不执行 JavaScript——纯 CSR 站在它们眼里是空白页，这一项不解决其他优化都白做。',
    },
    globalBlocked: (names, engines) => ({
      title: `解除对海外 AI 爬虫的屏蔽：${names.join('、')}`,
      why: `影响 ${engines.join('、')} 的收录。`,
    }),
    schema: {
      title: '添加 JSON-LD 结构化数据（Organization + Article/Product）',
      why: 'AI 引擎靠结构化数据快速确认"你是谁、卖什么"，没有它就只能靠猜。',
    },
    triggers: (missing) => ({
      title: `补充可引用内容元素：${missing.join('、')}`,
      why: 'AI 回答时偏爱直接引用表格、数据、步骤——没有这些元素，你的页面很难被"抄进"答案里。',
    }),
    timestamp: {
      title: '给页面加可见的"更新于 YYYY-MM"时间标记',
      why: '新鲜度是 AI 引用的重要信号，3 个月不更新被引概率显著下降。',
    },
    sitemap: {
      title: '创建 sitemap.xml 并在 robots.txt 中引用',
      why: '帮助所有引擎发现你的内容资产。',
    },
    llmsTxt: {
      title: '添加 /llms.txt',
      why: '新兴标准，成本极低。目前对引用排名影响有限，但能让 AI 工具快速理解站点结构。',
    },
    unreachable: (url, reason) => `无法访问 ${url}（${reason}），请确认网址正确且网站在线。`,
  },
  en: {
    cnBlocked: (names, engines) => ({
      title: `Unblock Chinese AI crawlers: ${names.join(', ')}`,
      why: `This directly decides whether ${engines.join(', ')} can index your content. Note: overseas-facing guides often recommend blocking Bytespider — but for the Chinese market you must allow it (it feeds the Doubao ecosystem).`,
    }),
    csr: {
      title: 'Page looks client-side rendered (CSR) — switch to SSR or prerendering',
      why: "AI engine crawlers generally don't execute JavaScript. A pure CSR site is a blank page to them; until this is fixed, every other optimization is wasted.",
    },
    globalBlocked: (names, engines) => ({
      title: `Unblock global AI crawlers: ${names.join(', ')}`,
      why: `Affects indexing by ${engines.join(', ')}.`,
    }),
    schema: {
      title: 'Add JSON-LD structured data (Organization + Article/Product)',
      why: 'AI engines rely on structured data to quickly confirm who you are and what you sell — without it, they have to guess.',
    },
    triggers: (missing) => ({
      title: `Add citation-worthy content elements: ${missing.join(', ')}`,
      why: 'AI answers love to quote tables, numbers and step-by-step lists directly — without these elements, your page rarely gets "copied into" an answer.',
    }),
    timestamp: {
      title: 'Add a visible "Updated YYYY-MM" timestamp to pages',
      why: 'Freshness is a key citation signal — pages untouched for 3+ months see a sharp drop in citation probability.',
    },
    sitemap: {
      title: 'Create sitemap.xml and reference it in robots.txt',
      why: 'Helps every engine discover your content assets.',
    },
    llmsTxt: {
      title: 'Add /llms.txt',
      why: 'An emerging standard with near-zero cost. Limited ranking impact today, but it lets AI tools grasp your site structure instantly.',
    },
    unreachable: (url, reason) => `Could not reach ${url} (${reason}). Please check the URL and make sure the site is online.`,
  },
};

function buildActions(page, sitemap, robots, llmsTxtExists, lang) {
  const t = ACTION_TEXT[lang];
  const actions = [];

  const cnBlocked = robots.cn.filter((c) => c.status === 'blocked');
  if (cnBlocked.length > 0) {
    actions.push({ priority: 'P0', ...t.cnBlocked(cnBlocked.map((c) => c.name), cnBlocked.map((c) => c.engine)) });
  }

  if (page.likelyCSR) {
    actions.push({ priority: 'P0', ...t.csr });
  }

  const globalBlocked = robots.global.filter((c) => c.status === 'blocked');
  if (globalBlocked.length > 0) {
    actions.push({ priority: 'P1', ...t.globalBlocked(globalBlocked.map((c) => c.name), globalBlocked.map((c) => c.engine)) });
  }

  if (page.schemaTypes.length === 0) {
    actions.push({ priority: 'P1', ...t.schema });
  }

  if (page.triggers.length < 4) {
    const missing = CITATION_TRIGGERS.filter((tr) => !page.triggers.includes(tr.key)).map((tr) => tr.label[lang]);
    actions.push({ priority: 'P1', ...t.triggers(missing.slice(0, 3)) });
  }

  if (!page.hasUpdateTimestamp) {
    actions.push({ priority: 'P2', ...t.timestamp });
  }

  if (!sitemap.exists) {
    actions.push({ priority: 'P2', ...t.sitemap });
  }

  if (!llmsTxtExists) {
    actions.push({ priority: 'P3', ...t.llmsTxt });
  }

  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  actions.sort((a, b) => order[a.priority] - order[b.priority]);
  return actions;
}

// ─── 主入口 ───────────────────────────────────────────

export async function scanSite(siteUrl, lang = 'zh') {
  if (!ACTION_TEXT[lang]) lang = 'zh';

  const [home, robots, sitemap0, llmsTxt] = await Promise.all([
    fetchSafe(siteUrl),
    fetchSafe(`${siteUrl}/robots.txt`, 6000),
    fetchSafe(`${siteUrl}/sitemap.xml`, 6000),
    fetchSafe(`${siteUrl}/llms.txt`, 6000),
  ]);

  // Astro/WordPress 等常用 sitemap-index.xml / sitemap_index.xml
  let sitemap = sitemap0;
  if (!sitemap.ok || (!sitemap.body.includes('<url>') && !sitemap.body.includes('<sitemap>'))) {
    for (const alt of ['sitemap-index.xml', 'sitemap_index.xml']) {
      const res = await fetchSafe(`${siteUrl}/${alt}`, 6000);
      if (res.ok && (res.body.includes('<url>') || res.body.includes('<sitemap>'))) {
        sitemap = res;
        break;
      }
    }
  }

  if (!home.ok) {
    return { ok: false, error: ACTION_TEXT[lang].unreachable(siteUrl, home.error || 'HTTP ' + home.status) };
  }

  const robotsA = analyzeRobots(robots.ok ? robots.body : '', lang);
  const page = analyzePage(home.body);
  const sitemapA = analyzeSitemap(sitemap.ok ? sitemap.body : '');
  const llmsTxtExists = llmsTxt.ok && llmsTxt.body.trim().length > 0 && !llmsTxt.body.trim().startsWith('<');

  const common = scoreCommon(page, sitemapA, robotsA);

  // 中文轨：通用分 60% + 中文爬虫可达 25% + 中文内容比例 15%
  const cnScore = Math.round(
    Math.min(100, common * 0.6 + allowedRatio(robotsA.cn) * 25 + Math.min(page.cjkRatio * 2, 1) * 15)
  );
  // 海外轨：通用分 60% + 海外爬虫可达 25% + 英文可达性（hreflang/英文内容） 15%
  const enSignal = page.cjkRatio < 0.3 ? 1 : page.hreflangCount > 0 ? 0.7 : 0;
  const globalScore = Math.round(Math.min(100, common * 0.6 + allowedRatio(robotsA.global) * 25 + enSignal * 15));

  const overall = Math.round(cnScore * 0.5 + globalScore * 0.5);

  return {
    ok: true,
    url: siteUrl,
    lang,
    scannedAt: new Date().toISOString(),
    scores: { overall, china: cnScore, global: globalScore },
    crawlers: { cn: robotsA.cn, global: robotsA.global },
    checks: {
      robotsTxt: robotsA.exists,
      sitemap: sitemapA.exists,
      sitemapUrls: sitemapA.urlCount,
      llmsTxt: llmsTxtExists,
      ssr: !page.likelyCSR,
      schemaTypes: page.schemaTypes,
      hasUpdateTimestamp: page.hasUpdateTimestamp,
      contentLanguage: page.cjkRatio > 0.3 ? 'chinese' : page.cjkRatio > 0.1 ? 'mixed' : 'english',
      triggers: CITATION_TRIGGERS.map((t) => ({ key: t.key, stars: t.stars, label: t.label[lang], found: page.triggers.includes(t.key) })),
    },
    pageMeta: { title: page.title, h1: page.h1, description: page.metaDescription.slice(0, 120) },
    actions: buildActions(page, sitemapA, robotsA, llmsTxtExists, lang).slice(0, 5),
  };
}
