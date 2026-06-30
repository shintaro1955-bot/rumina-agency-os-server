// Rumina 代理店開拓OS — データ層(SQLite / 小規模本番)
// 将来Postgresへ差し替え可能なよう、アクセスは下の関数経由に限定する。
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "rumina.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
  name TEXT, role TEXT DEFAULT '担当', area TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER, updated_by TEXT
);
CREATE TABLE IF NOT EXISTS kpi_events (
  id TEXT PRIMARY KEY, date TEXT, owner TEXT, area TEXT, metric TEXT,
  delta INTEGER DEFAULT 1, manual INTEGER DEFAULT 0, company_id TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS nippo_log (
  id TEXT PRIMARY KEY, date TEXT, owner TEXT, area TEXT, json TEXT,
  submitted_at INTEGER, submitted_by TEXT
);
CREATE TABLE IF NOT EXISTS report_state (
  key TEXT PRIMARY KEY, json TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, json TEXT);
CREATE INDEX IF NOT EXISTS idx_events_date ON kpi_events(date);
CREATE INDEX IF NOT EXISTS idx_nippo_owner ON nippo_log(owner);
`);

const now = () => Date.now();

export const Accounts = {
  count: () => db.prepare("SELECT COUNT(*) c FROM accounts").get().c,
  byEmail: (email) => db.prepare("SELECT * FROM accounts WHERE email=?").get(String(email || "").toLowerCase()),
  byId: (id) => db.prepare("SELECT * FROM accounts WHERE id=?").get(id),
  create: (a) => {
    db.prepare("INSERT INTO accounts (id,email,pass_hash,name,role,area,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(a.id, a.email.toLowerCase(), a.pass_hash, a.name || "", a.role || "担当", a.area || "", now());
    return Accounts.byId(a.id);
  },
  update: (id, patch) => {
    const cur = Accounts.byId(id); if (!cur) return null;
    const m = { ...cur, ...patch };
    db.prepare("UPDATE accounts SET name=?,role=?,area=?,pass_hash=? WHERE id=?")
      .run(m.name, m.role, m.area, m.pass_hash, id);
    return Accounts.byId(id);
  },
  list: () => db.prepare("SELECT id,email,name,role,area,created_at FROM accounts ORDER BY created_at").all(),
};

export const Companies = {
  list: () => db.prepare("SELECT json FROM companies ORDER BY updated_at DESC").all().map((r) => JSON.parse(r.json)),
  upsertMany: (arr, by) => {
    const stmt = db.prepare("INSERT INTO companies (id,json,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at, updated_by=excluded.updated_by");
    const tx = db.transaction((items) => { for (const c of items) stmt.run(c.id, JSON.stringify(c), now(), by || ""); });
    tx(arr); return arr.length;
  },
  remove: (id) => db.prepare("DELETE FROM companies WHERE id=?").run(id).changes,
  clear: () => db.prepare("DELETE FROM companies").run().changes,
};

export const Events = {
  list: () => db.prepare("SELECT * FROM kpi_events").all().map((e) => ({ ...e, manual: !!e.manual })),
  appendMany: (arr) => {
    const stmt = db.prepare("INSERT OR IGNORE INTO kpi_events (id,date,owner,area,metric,delta,manual,company_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    const tx = db.transaction((items) => { for (const e of items) stmt.run(e.id, e.date, e.owner, e.area, e.metric, e.delta ?? 1, e.manual ? 1 : 0, e.companyId || e.company_id || null, now()); });
    tx(arr); return arr.length;
  },
  replaceAll: (arr) => {
    const tx = db.transaction((items) => {
      db.prepare("DELETE FROM kpi_events").run();
      const stmt = db.prepare("INSERT INTO kpi_events (id,date,owner,area,metric,delta,manual,company_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
      for (const e of items) stmt.run(e.id, e.date, e.owner, e.area, e.metric, e.delta ?? 1, e.manual ? 1 : 0, e.companyId || null, now());
    });
    tx(arr); return arr.length;
  },
};

export const Nippo = {
  list: (filter = {}) => {
    let sql = "SELECT json FROM nippo_log"; const where = []; const args = [];
    if (filter.owner) { where.push("owner=?"); args.push(filter.owner); }
    if (filter.date) { where.push("date=?"); args.push(filter.date); }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY submitted_at DESC";
    return db.prepare(sql).all(...args).map((r) => JSON.parse(r.json));
  },
  add: (e, by) => {
    db.prepare("INSERT INTO nippo_log (id,date,owner,area,json,submitted_at,submitted_by) VALUES (?,?,?,?,?,?,?)")
      .run(e.id, e.date, e.owner, e.area || "", JSON.stringify(e), e.submittedAt || now(), by || "");
    return true;
  },
};

export const ReportState = {
  all: () => Object.fromEntries(db.prepare("SELECT key,json FROM report_state").all().map((r) => [r.key, JSON.parse(r.json)])),
  set: (key, val) => db.prepare("INSERT INTO report_state (key,json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at").run(key, JSON.stringify(val), now()),
};

export const KV = {
  get: (k, def = null) => { const r = db.prepare("SELECT json FROM kv WHERE k=?").get(k); return r ? JSON.parse(r.json) : def; },
  set: (k, v) => db.prepare("INSERT INTO kv (k,json) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET json=excluded.json").run(k, JSON.stringify(v)),
};

export default db;
