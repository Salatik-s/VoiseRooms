import { createHmac } from "node:crypto";
import { sameSecret } from "./security.js";
export function verifyInitData(input, token, now = Date.now()) {
  try {
    if (typeof input !== "string" || !token || input.length > 16384)
      return null;
    const p = new URLSearchParams(input);
    if (new Set(p.keys()).size !== [...p.keys()].length) return null;
    const hash = p.get("hash"),
      date = Number(p.get("auth_date"));
    if (
      !/^[a-f0-9]{64}$/.test(hash || "") ||
      !Number.isFinite(date) ||
      date * 1000 > now + 30000 ||
      now - date * 1000 > 3600000
    )
      return null;
    p.delete("hash");
    const data = [...p]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => k + "=" + v)
      .join("\n");
    const key = createHmac("sha256", "WebAppData").update(token).digest();
    if (!sameSecret(hash, createHmac("sha256", key).update(data).digest("hex")))
      return null;
    const u = JSON.parse(p.get("user"));
    if (!Number.isSafeInteger(u.id) || u.id <= 0) return null;
    return {
      id: u.id,
      firstName: u.first_name || "",
      lastName: u.last_name || "",
      username: u.username || "",
      languageCode: u.language_code || "ru",
    };
  } catch {
    return null;
  }
}
