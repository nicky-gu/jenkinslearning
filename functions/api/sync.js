/* ==========================================================================
   Cloudflare Pages Function · /api/sync
   多端同步后端：用「同步口令」派生 KV key，整块 JSON 存云端。
   - GET   拉取：返回 { data, updated_at }；无数据返回 404
   - POST  推送：{ data, updated_at }，若云端更新则 409 冲突返回云端数据
   冲突策略：后写覆盖（last-write-wins）。
   KV 绑定变量名：WORDLAND_SYNC（在 Pages 项目设置里绑定）
   ========================================================================== */

function getPass(request) {
  const h = request.headers.get("Authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return "";
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const kv = env.WORDLAND_SYNC;
  if (!kv) return json({ error: "KV 未绑定（请在 Pages 设置里绑定 WORDLAND_SYNC）" }, 500);
  const pass = getPass(request);
  if (!pass) return json({ error: "缺少同步口令" }, 401);
  const key = "sync:" + (await sha256Hex(pass));
  const raw = await kv.get(key);
  if (!raw) return json({ error: "not found" }, 404);
  try {
    return json(JSON.parse(raw));
  } catch {
    return json({ error: "数据损坏" }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.WORDLAND_SYNC;
  if (!kv) return json({ error: "KV 未绑定（请在 Pages 设置里绑定 WORDLAND_SYNC）" }, 500);
  const pass = getPass(request);
  if (!pass) return json({ error: "缺少同步口令" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }
  if (!body || typeof body.data === "undefined") {
    return json({ error: "缺少 data 字段" }, 400);
  }

  const key = "sync:" + (await sha256Hex(pass));
  const incomingAt = Number(body.updated_at) || Date.now();

  // 冲突保护：若云端时间戳更新，拒收并返回云端数据，由客户端以云端为准
  const existingRaw = await kv.get(key);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      if (existing.updated_at && existing.updated_at > incomingAt) {
        return json(
          { error: "conflict", data: existing.data, updated_at: existing.updated_at },
          409
        );
      }
    } catch {
      /* 云端数据损坏则直接覆盖 */
    }
  }

  const stored = { data: body.data, updated_at: incomingAt };
  await kv.put(key, JSON.stringify(stored));
  return json({ ok: true, updated_at: incomingAt });
}
