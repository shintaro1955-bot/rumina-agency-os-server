// Rumina — 認証(メール＋パスワード / JWT / ロール)
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Accounts } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "rumina-dev-secret-change-me";
const TOKEN_TTL = "30d";
const genId = () => "u_" + crypto.randomBytes(6).toString("hex");

export function register({ email, password, name, area }) {
  email = String(email || "").trim().toLowerCase();
  if (!email || !/.+@.+\..+/.test(email)) throw new Error("メールアドレスが不正です");
  if (!password || password.length < 6) throw new Error("パスワードは6文字以上にしてください");
  if (Accounts.byEmail(email)) throw new Error("このメールは既に登録されています");
  // 最初の登録者をマネージャー(管理者)に
  const role = Accounts.count() === 0 ? "マネージャー" : "担当";
  const acc = Accounts.create({ id: genId(), email, pass_hash: bcrypt.hashSync(password, 10), name: name || "", role, area: area || "" });
  return { token: sign(acc), user: pub(acc) };
}

export function login({ email, password }) {
  const acc = Accounts.byEmail(String(email || "").trim().toLowerCase());
  if (!acc || !bcrypt.compareSync(password || "", acc.pass_hash)) throw new Error("メールまたはパスワードが違います");
  return { token: sign(acc), user: pub(acc) };
}

export function changePassword(id, password) {
  if (!password || password.length < 6) throw new Error("パスワードは6文字以上にしてください");
  Accounts.update(id, { pass_hash: bcrypt.hashSync(password, 10) });
  return true;
}

const sign = (acc) => jwt.sign({ uid: acc.id, role: acc.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
export const pub = (a) => ({ id: a.id, email: a.email, name: a.name, role: a.role, area: a.area, createdAt: a.created_at });

export function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: "ログインが必要です" });
  try {
    const p = jwt.verify(m[1], JWT_SECRET);
    const acc = Accounts.byId(p.uid);
    if (!acc) return res.status(401).json({ error: "アカウントが見つかりません" });
    req.user = acc;
    next();
  } catch (e) { return res.status(401).json({ error: "セッションが無効です。再ログインしてください" }); }
}
