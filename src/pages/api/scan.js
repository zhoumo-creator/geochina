/**
 * POST /api/scan  { url: "example.com" }
 * 在线 GEO 扫描接口。带域名级缓存（7 天）和 IP 限流（每天 5 次）。
 * 缓存和限流都是实例内存级——serverless 冷启动会重置，MVP 阶段够用。
 */
import { normalizeUrl, scanSite } from '../../lib/geo-scan.js';

export const prerender = false;

const CACHE_TTL = 7 * 24 * 3600 * 1000;
const DAILY_LIMIT = 5;

const cache = new Map(); // origin -> { result, ts }
const ipHits = new Map(); // ip -> { day, count }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function POST({ request, clientAddress }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '请求格式错误' }, 400);
  }

  const siteUrl = normalizeUrl(body.url);
  if (!siteUrl) {
    return json({ ok: false, error: '请输入有效的网址，例如 example.com' }, 400);
  }

  // 缓存命中不计限流
  const cached = cache.get(siteUrl);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return json({ ...cached.result, cached: true });
  }

  const ip = clientAddress || request.headers.get('x-forwarded-for') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const hits = ipHits.get(ip);
  if (hits && hits.day === day && hits.count >= DAILY_LIMIT) {
    return json({ ok: false, error: `今天的免费扫描次数用完了（${DAILY_LIMIT} 次/天）。想要不限次数 + 每周自动监控？联系 hi@geochina.co` }, 429);
  }
  ipHits.set(ip, { day, count: hits && hits.day === day ? hits.count + 1 : 1 });

  try {
    const result = await scanSite(siteUrl);
    if (result.ok) cache.set(siteUrl, { result, ts: Date.now() });
    return json(result, result.ok ? 200 : 422);
  } catch (e) {
    return json({ ok: false, error: '扫描过程出错，请稍后重试。' }, 500);
  }
}
