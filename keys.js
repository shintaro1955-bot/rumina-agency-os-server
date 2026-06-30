// Rumina — APIキー自動解決
// 優先順: 自分の環境変数(.env / ホストの環境変数) → 兄弟プロジェクトの .env を自動スキャン
// 値はログに出さない。/health には「どのファイルから取得したか」だけ出す。
import fs from "fs";
import path from "path";

const WANT = {
  anthropic: { names: ["ANTHROPIC_API_KEY"], valid: (v) => /^sk-ant-/.test(v) },
  googleMaps: { names: ["GOOGLE_MAPS_API_KEY", "GOOGLE_API_KEY"], valid: (v) => /^AIza/.test(v) },
  cseKey: { names: ["GOOGLE_CSE_KEY"], valid: (v) => v.length > 10 },
  cseId: { names: ["GOOGLE_CSE_ID"], valid: (v) => v.length > 5 },
  slack: { names: ["SLACK_WEBHOOK", "SLACK_WEBHOOK_URL"], valid: (v) => /^https:\/\/hooks\.slack\.com/.test(v) },
};

const ENV_FILES = [".env", ".env.local"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".bin", "agency-crawler"]);

function parseEnvFile(file) {
  const out = {};
  let txt = "";
  try { txt = fs.readFileSync(file, "utf8"); } catch (e) { return out; }
  for (let line of txt.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && v) out[k] = v;
  }
  return out;
}

// rootDir(=Downloads等)直下の各プロジェクトの .env を集める { VARNAME: [{value, source}] }
function scanSiblings(rootDir) {
  const found = {};
  let entries = [];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch (e) { return found; }
  for (const ent of entries) {
    if (!ent.isDirectory() || SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
    for (const ef of ENV_FILES) {
      const file = path.join(rootDir, ent.name, ef);
      if (!fs.existsSync(file)) continue;
      const vars = parseEnvFile(file);
      for (const [k, v] of Object.entries(vars)) {
        (found[k] ||= []).push({ value: v, source: `${ent.name}/${ef}` });
      }
    }
  }
  return found;
}

export function resolveKeys({ rootDir, scan = true } = {}) {
  const sib = scan ? scanSiblings(rootDir) : {};
  const result = {};
  const sources = {};
  for (const [key, spec] of Object.entries(WANT)) {
    let picked = null;
    // 1) 自分の環境変数(最優先)
    for (const n of spec.names) {
      const v = process.env[n];
      if (v && spec.valid(v)) { picked = { value: v, source: "env" }; break; }
    }
    // 2) 兄弟プロジェクトの .env から(妥当な値を優先)
    if (!picked) {
      outer:
      for (const n of spec.names) {
        for (const cand of sib[n] || []) {
          if (spec.valid(cand.value)) { picked = cand; break outer; }
        }
      }
    }
    if (picked) { result[key] = picked.value; sources[key] = picked.source; }
  }
  return { keys: result, sources };
}
