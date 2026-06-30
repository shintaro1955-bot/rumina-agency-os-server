import "dotenv/config";
import express from "express";
import cors from "cors";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Companies, Events, Nippo, ReportState, KV, Accounts } from "./db.js";
import { register, login, changePassword, authRequired, pub } from "./auth.js";
import { resolveKeys } from "./keys.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// APIキー自動解決: 自分の.env → 兄弟プロジェクト(../*/.env)を自動スキャン
const KEY_SCAN_ROOT = process.env.KEY_SCAN_ROOT || path.join(__dirname, "..");
const RESOLVED = resolveKeys({ rootDir: KEY_SCAN_ROOT, scan: process.env.KEY_AUTOSCAN !== "0" });
for (const [k, src] of Object.entries(RESOLVED.sources)) {
  if (src !== "env") console.log(`[keys] ${k} を ${src} から自動取得`);
}

/* ============================================================
   Rumina 代理店開拓 — Google クローラ(バックエンド)
   Places API (New) の searchText で
   会社名・住所・電話(携帯含む)・サイトを1リクエストで取得して候補化する。
   ※APIキーはサーバ側だけに置く(ブラウザに出さない)
   ※Google Cloud で「Places API (New)」を有効化しておくこと
   ============================================================ */

const KEY = RESOLVED.keys.googleMaps;                    // Places(発掘)・地図
const CSE_KEY = RESOLVED.keys.cseKey || KEY;             // Custom Search 用(任意)
const CSE_ID = RESOLVED.keys.cseId || "";                // Programmable Search Engine ID(任意)
const ANTHROPIC_KEY = RESOLVED.keys.anthropic;           // AI(リサーチ/発掘/日報)用
const PORT = process.env.PORT || 8787;

const app = express();
app.use(cors());                 // ブラウザ(アプリ)から叩けるように
app.use(express.json({ limit: "2mb" }));

/* ---------- AI プロキシ(Anthropic) — キーをサーバ側に隠す ---------- */
app.post("/api/ai", async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY が未設定です。.env に設定してください。" });
    const body = req.body || {};
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    };
    // web_search ツール使用時はベータヘッダを付与(無害)
    const usesWebSearch = Array.isArray(body.tools) && body.tools.some((t) => /web_search/.test(t.type || t.name || ""));
    if (usesWebSearch) headers["anthropic-beta"] = "web-search-2025-03-05";
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const onlyDigits = (s) => (s || "").replace(/[^0-9]/g, "");
// 携帯=070/080/090。ただしフリーダイヤル(0800/0120/0570/0990)は除外
const isMobile = (phone) => { const d = onlyDigits(phone); return /^0[789]0/.test(d) && !/^(0800|0120|0570|0990)/.test(d); };

// エリア×ペルソナから検索クエリを生成(営業会社/販売代理店を狙う)
function buildQueries(area, keyword) {
  const a = area && area !== "全国" ? area : "";
  const base = [
    `${a} 光回線 訪問販売 会社`,
    `${a} 通信回線 販売代理店`,
    `${a} 訪問販売 営業代行 会社`,
    `${a} 催事 イベント販売 会社`,
    `${a} 美容 健康食品 訪問販売 会社`,
  ];
  const q = keyword
    ? [`${a} ${keyword} 訪問販売 会社`, `${a} ${keyword} 販売代理店`, `${a} ${keyword} 営業会社`, ...base]
    : base;
  return q.map((s) => s.trim()).filter(Boolean);
}

// 代理店候補にならない先(官公庁/協会/組合/大手キャリア本社/インフラ/教育医療/小売チェーン本体)を除外
const EXCLUDE_NAME = /(総務省|通信局|市役所|区役所|町役場|村役場|県庁|都庁|府庁|道庁|役所|官公庁|商工会議所|商工会|協同組合|協会|公社|財団法人|一般社団|公益社団|独立行政法人|振興会|大学|高校|中学校|小学校|学校法人|病院|クリニック|郵便局|警察|消防|裁判所|図書館|ＮＴＴ東日本|ＮＴＴ西日本|NTT東日本|NTT西日本|日本電信電話|ＮＴＴドコモ|NTTドコモ|ＫＤＤＩ|KDDI|ソフトバンク株式会社|楽天モバイル株式会社|東京電力|関西電力|中部電力|東邦ガス|大阪ガス|東京ガス)/;
const EXCLUDE_TYPE = new Set(["local_government_office", "city_hall", "government_office", "post_office", "police", "fire_station", "courthouse", "embassy", "school", "primary_school", "secondary_school", "university", "hospital", "library"]);
function isExcluded(name, types) {
  if (EXCLUDE_NAME.test(name || "")) return true;
  if (Array.isArray(types) && types.some((t) => EXCLUDE_TYPE.has(t))) return true;
  return false;
}

// AIで二次選別: 営業会社/販売代理店だけ残す(キーがある時のみ)
async function aiRefine(list, { area, keyword }) {
  if (!ANTHROPIC_KEY || !list.length) return list;
  try {
    const sys = "あなたは代理店開拓の選定担当です。与えた企業リストから『ライト商材(通信回線/光/携帯/浄水器/美容/健康食品/日用品/省エネ等)の訪問販売・催事・営業代行を行う“営業会社/販売代理店”で、当社の代理店候補になり得る先』だけを選びます。官公庁・自治体・協会・組合・大手キャリア本社・インフラ/メーカー本体・単独の小売店舗・士業・医療教育は keep=false。出力はJSON配列のみ(前置き/説明/マークダウン不要)。各要素: {name(入力のnameをそのまま), keep(true|false), channel('訪販'|'催事'|'両方'|'不明'), reason(20字以内)}。";
    const usr = `エリア:${area} 条件:${keyword || "なし"}\n企業:\n` + list.map((c, i) => `${i + 1}. ${c.name} | types:${(c.types || []).slice(0, 4).join(",")} | ${c.address || ""} | ${c.url || ""}`).join("\n");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, system: sys, messages: [{ role: "user", content: usr }] }),
    });
    const d = await r.json();
    const text = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const m = text.replace(/```json|```/g, "").match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : text);
    const norm = (s) => String(s || "").replace(/\s|株式会社|（株）|\(株\)/g, "");
    const verdict = new Map(arr.map((v) => [norm(v.name), v]));
    const kept = [];
    for (const c of list) {
      const v = verdict.get(norm(c.name));
      if (v && v.keep === false) continue;
      if (v) { c.channel = v.channel || "不明"; c.reason = v.reason || ""; }
      kept.push(c);
    }
    return kept.length ? kept : list; // 全部落ちたら安全側で元を返す
  } catch (e) { return list; }
}

const FIELD_MASK = [
  "places.id", "places.displayName", "places.formattedAddress",
  "places.nationalPhoneNumber", "places.internationalPhoneNumber",
  "places.websiteUri", "places.businessStatus", "places.types", "places.googleMapsUri",
].join(",");

// Places API (New) Text Search
async function placesTextSearch(query, pageSize = 20) {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: query, languageCode: "ja", regionCode: "JP", pageSize: Math.min(20, pageSize) }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Places(New): ${d.error.status || d.error.code} - ${d.error.message || ""}`.trim());
  return d.places || [];
}

// 任意: Custom Search で公式サイト/新設ベンチャーを補完
async function customSearchSite(name) {
  if (!CSE_ID) return "";
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${CSE_KEY}&cx=${CSE_ID}&num=1&q=${encodeURIComponent(name + " 会社 公式")}`;
    const r = await fetch(url);
    const d = await r.json();
    return d.items?.[0]?.link || "";
  } catch { return ""; }
}

/* ---------- Slack 通知 ---------- */
const SLACK_WEBHOOK = RESOLVED.keys.slack || "";
async function postSlack(text) {
  if (!SLACK_WEBHOOK) return false;
  try { await fetch(SLACK_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }); return true; } catch (e) { return false; }
}

/* ---------- 認証(メール＋パスワード) ---------- */
app.post("/api/auth/register", (req, res) => {
  try { res.json(register(req.body || {})); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post("/api/auth/login", (req, res) => {
  try { res.json(login(req.body || {})); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get("/api/me", authRequired, (req, res) => res.json({ user: pub(req.user) }));
app.post("/api/me/password", authRequired, (req, res) => {
  try { changePassword(req.user.id, (req.body || {}).password); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get("/api/members", authRequired, (req, res) => res.json({ members: Accounts.list() }));

/* ---------- 共有データ(要ログイン) ---------- */
app.get("/api/companies", authRequired, (req, res) => res.json({ companies: Companies.list() }));
app.post("/api/companies", authRequired, (req, res) => {
  const b = req.body || {}; const arr = Array.isArray(b) ? b : (b.companies || (b.id ? [b] : []));
  res.json({ ok: true, count: Companies.upsertMany(arr, req.user.name || req.user.email) });
});
app.delete("/api/companies/:id", authRequired, (req, res) => res.json({ ok: true, removed: Companies.remove(req.params.id) }));
app.delete("/api/companies", authRequired, (req, res) => res.json({ ok: true, removed: Companies.clear() }));

app.get("/api/events", authRequired, (req, res) => res.json({ events: Events.list() }));
app.post("/api/events", authRequired, (req, res) => {
  const b = req.body || {}; const arr = Array.isArray(b) ? b : (b.events || [b]);
  if (b.replace) return res.json({ ok: true, count: Events.replaceAll(arr) });
  res.json({ ok: true, count: Events.appendMany(arr) });
});

app.get("/api/goals", authRequired, (req, res) => res.json({ goals: KV.get("goals") }));
app.put("/api/goals", authRequired, (req, res) => { KV.set("goals", (req.body || {}).goals || req.body); res.json({ ok: true }); });

app.get("/api/reportstate", authRequired, (req, res) => res.json({ reports: ReportState.all() }));
app.put("/api/reportstate", authRequired, (req, res) => { const b = req.body || {}; if (b.key) ReportState.set(b.key, b.value); res.json({ ok: true }); });

/* ---------- 日報 台帳(DB・要ログイン) ---------- */
app.post("/api/nippo", authRequired, async (req, res) => {
  try {
    const e = { ...(req.body || {}) };
    if (!e.id) e.id = "n_" + Math.random().toString(36).slice(2);
    if (!e.submittedAt) e.submittedAt = Date.now();
    Nippo.add(e, req.user.name || req.user.email);
    const m = e.metrics || {};
    await postSlack(`【代理店開拓 日報】${e.date} ${e.owner}\n架電${m.calls || 0}/担当者接続${m.personConnects || 0}/面談${m.meetingGot || 0}/対面${m.inPerson || 0}/候補化${m.candidate || 0}/契約${m.contract || 0}\n良かった点: ${e.good || "-"}\n明日の重点: ${e.tomorrow || "-"}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get("/api/nippo", authRequired, (req, res) => res.json({ entries: Nippo.list({ owner: req.query.owner, date: req.query.date }) }));

app.get("/health", (_req, res) => res.json({ ok: true, placesKey: !!KEY, customSearch: !!CSE_ID, ai: !!ANTHROPIC_KEY, db: true, slack: !!SLACK_WEBHOOK, accounts: Accounts.count(), keySources: RESOLVED.sources }));

app.post("/api/discover", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "GOOGLE_MAPS_API_KEY が未設定です。Places API (New) を有効化したキーを設定してください。" });
    const { area = "全国", count = 8, keyword = "", aiFilter = true } = req.body || {};
    const want = Math.max(1, Math.min(30, Number(count) || 8));

    const seen = new Set();
    let out = [];
    let excluded = 0;
    for (const q of buildQueries(area, keyword)) {
      const places = await placesTextSearch(q, 20);
      for (const p of places) {
        const id = p.id || (p.displayName?.text || "");
        if (seen.has(id)) continue;
        seen.add(id);
        if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
        const name = p.displayName?.text || "";
        if (isExcluded(name, p.types)) { excluded++; continue; }   // ① 官公庁/大手等を除外
        const phone = p.nationalPhoneNumber || p.internationalPhoneNumber || "";
        out.push({
          name, url: p.websiteUri || "", area,
          address: p.formattedAddress || "",
          phone,
          mobileOnly: !!phone && isMobile(phone),
          types: p.types || [],
          maps: p.googleMapsUri || "",
        });
      }
      if (out.length >= want * 3) break;   // AI選別の余地を持って多めに収集
    }

    // ③ AIで二次選別(営業会社/販売代理店だけ残す)
    const before = out.length;
    if (aiFilter) out = await aiRefine(out, { area, keyword });

    // サイト未取得は Custom Search で補完(任意・残った分だけ)
    if (CSE_ID) for (const c of out.slice(0, want)) { if (!c.url) c.url = await customSearchSite(c.name); }

    // 携帯のみ/連絡先ありを優先(新設ベンチャーが上に来やすい)
    out.sort((a, b) => (Number(b.mobileOnly) - Number(a.mobileOnly)) || ((b.phone ? 1 : 0) - (a.phone ? 1 : 0)));
    res.json({ companies: out.slice(0, want), scanned: seen.size, excluded, aiFiltered: aiFilter ? (before - out.length) : 0 });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ---------- アプリ本体を同梱配信(ローカル1サーバー運用) ---------- */
import { existsSync } from "fs";
const APP_DIR = process.env.APP_DIR
  || (existsSync(path.join(__dirname, "public", "index.html")) ? path.join(__dirname, "public") : path.join(__dirname, "..", "agency_site"));
app.use(express.static(APP_DIR));

app.listen(PORT, () => console.log(`Rumina OS on http://localhost:${PORT}  (app:${APP_DIR} ai:${!!ANTHROPIC_KEY} places:${!!KEY})`));
