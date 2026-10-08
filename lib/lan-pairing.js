// LAN の端末（iPad など）をつなぐ「ペアリング」
//  ・PC の画面で 6 桁の番号を表示し、iPad でその番号を入れた端末だけが使えるようにする
//  ・番号は 5 分で期限が切れ、間違えられるのは 5 回まで（総当たりで当てられないように）。一度使うと無効
//  ・つないだ端末には長い合言葉（トークン）を Cookie で渡し、サーバーにはそのハッシュだけを保存する
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LABEL_MAX = 40;

// ---------- ペアリングの番号（同時に有効なのはひとつだけ） ----------
function createPairingCodes({ ttlMs = CODE_TTL_MS, maxAttempts = MAX_ATTEMPTS, now = Date.now, randomInt = crypto.randomInt } = {}) {
  let active = null;   // { code, expiresAt, attempts }
  function live() {
    if (active && now() >= active.expiresAt) active = null;
    return active;
  }
  return {
    issue() {
      active = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: now() + ttlMs, attempts: 0 };
      return { code: active.code, expiresAt: active.expiresAt };
    },
    // 合っていれば true（その番号はもう使えなくなる）。間違いが maxAttempts 回になったら番号を無効にする
    redeem(input) {
      const cur = live();
      if (!cur) return false;
      const given = Buffer.from(String(input ?? "").replace(/\D/g, ""));
      const expected = Buffer.from(cur.code);
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
        active = null;
        return true;
      }
      active = cur.attempts + 1 >= maxAttempts ? null : { ...cur, attempts: cur.attempts + 1 };
      return false;
    },
    pending() {
      const cur = live();
      return cur ? { expiresAt: cur.expiresAt } : null;
    },
  };
}

// ---------- つないだ端末（file に保存） ----------
const hashOf = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
// 名前は PC の画面と黒いウィンドウに出すので、制御文字・表示の向きを変える文字・改行・< > を除く
const cleanLabel = (s) => String(s ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029<>]/gu, "").trim().slice(0, LABEL_MAX) || "名前なしの端末";
const publicDevice = ({ id, label, ip = "", createdAt }) => ({ id, label, ip, createdAt });

function loadDevices(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j.devices) ? j.devices.filter((d) => d && typeof d.hash === "string") : [];
  } catch { return []; }
}

function createDeviceStore({ file, now = Date.now }) {
  let devices = loadDevices(file);
  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ devices: next }, null, 2), { mode: 0o600 });
    devices = next;
  }
  return {
    // 端末を登録して、その端末に渡すトークンを返す（ip: つないだときの端末の IP アドレス。PC の画面で確かめられるように）
    add(label, ip = "") {
      const token = crypto.randomBytes(32).toString("base64url");
      const device = { id: crypto.randomUUID(), label: cleanLabel(label), ip: String(ip), hash: hashOf(token), createdAt: now() };
      save([...devices, device]);
      return { token, device: publicDevice(device) };
    },
    verify(token) {
      if (!token) return null;
      const h = hashOf(token);
      const found = devices.find((d) => d.hash === h);
      return found ? publicDevice(found) : null;
    },
    list() { return devices.map(publicDevice); },
    removeAll() { save([]); },
  };
}

module.exports = { createPairingCodes, createDeviceStore };
