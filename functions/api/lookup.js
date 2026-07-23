/* ==========================================================================
   Cloudflare Pages Function · /api/lookup
   单词查词代理：聚合免费数据源，返回高质量中文释义 + 音标 + 例句。
   - 中文：LibreTranslate（开源 NMT，主源）→ MyMemory（兜底）
   - 音标/例句：dictionaryapi.dev（Wiktionary 数据）
   为什么走 Function：LibreTranslate 公共实例不支持浏览器 CORS，且聚合多源
   能减少前端请求、可加缓存降频。同源调用，前端无 CORS 问题。
   ========================================================================== */

const LT_INSTANCES = [
  "https://libretranslate.com/translate",
  "https://translate.argosopentech.com/translate",
];
const MYMEMORY = "https://api.mymemory.translated.net/get";
const DICT = "https://api.dictionaryapi.dev/api/v2/entries/en/";

// 简单内存缓存（按小写词缓存 10 分钟），降低公共实例频率
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

// 中文翻译：LibreTranslate 多实例 → MyMemory 兜底
async function fetchZh(en) {
  for (const url of LT_INSTANCES) {
    try {
      const r = await withTimeout(
        (signal) =>
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ q: en, source: "en", target: "zh", format: "text" }),
            signal,
          }),
        3000
      );
      if (r.ok) {
        const j = await r.json();
        if (j && j.translatedText) return j.translatedText;
      }
    } catch {
      /* 试下一个实例 */
    }
  }
  // 兜底 MyMemory
  try {
    const r = await withTimeout(
      (signal) => fetch(`${MYMEMORY}?q=${encodeURIComponent(en)}&langpair=en|zh-CN`, { signal }),
      3000
    );
    if (r.ok) {
      const j = await r.json();
      const zh = j && j.responseData && j.responseData.translatedText;
      if (zh && !/MYMEMORY WARNING/i.test(zh)) return zh;
    }
  } catch {
    /* ignore */
  }
  return "";
}

// 音标 + 例句
async function fetchPhoneticAndEx(en) {
  try {
    const r = await withTimeout((signal) => fetch(DICT + encodeURIComponent(en), { signal }), 3000);
    if (!r.ok) return { phonetic: "", ex: "" };
    const data = await r.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry) return { phonetic: "", ex: "" };
    const phonetic =
      entry.phonetic || (entry.phonetics || []).map((p) => p.text).find(Boolean) || "";
    let ex = "";
    (entry.meanings || []).some((m) =>
      (m.definitions || []).some((d) => {
        if (d.example) {
          ex = d.example;
          return true;
        }
        return false;
      })
    );
    return { phonetic, ex };
  } catch {
    return { phonetic: "", ex: "" };
  }
}

export async function onRequestGet(context) {
  const q = (context.request.url.split("?")[1] || "")
    .split("&")
    .map((s) => s.split("="))
    .find(([k]) => k === "q");
  const en = q && q[1] ? decodeURIComponent(q[1]).trim() : "";
  if (!en) return json({ error: "缺少 q 参数" }, 400);

  const key = en.toLowerCase();
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) {
    return json(Object.assign({ ok: true, cached: true }, hit.v));
  }

  // 并行拉取中文 与 音标/例句
  const [zh, pe] = await Promise.all([fetchZh(en), fetchPhoneticAndEx(en)]);

  const result = { phonetic: pe.phonetic || "", zh: zh || "", ex: pe.ex || "" };
  const ok = !!(result.zh || result.phonetic || result.ex);
  if (ok) CACHE.set(key, { t: Date.now(), v: result });

  return json({ ok, ...result });
}
