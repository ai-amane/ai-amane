// 設定の「iPad・スマホからつなぐ」（.env が LAN_ACCESS=1 のとき、この PC の画面にだけ表示する）
//  つなぐための番号を表示して iPad で入れてもらう。つないだ端末の解除もここから。
//  iPad などで開いた画面では /api/lan/status が使えないので、何も表示しない。
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const ui = { row: $("lanRow"), info: $("lanInfo"), code: $("lanCode"), btnCode: $("btnLanCode"), btnRevoke: $("btnLanRevoke") };
  const POLL_MS = 2000;
  let pollTimer = null;

  const deviceName = (d) => (d.ip ? `${d.label}（${d.ip}）` : d.label);
  const fmtLeft = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  async function getStatus() {
    try {
      const r = await fetch("/api/lan/status");
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  function render(st) {
    ui.row.hidden = !(st?.enabled || st?.configured);
    if (ui.row.hidden) return;
    ui.btnCode.hidden = ui.btnRevoke.hidden = !st.enabled;
    // .env で有効にしているが、まだ使えない（起動の直後・Wi-Fi 待ち・起動に失敗）
    if (!st.enabled) {
      ui.info.textContent = st.error ? `まだ使えません：${st.error}` : "準備しています…（少し待ってから、設定を開き直してください）";
      return;
    }
    const devices = st.devices.length ? `つないでいる端末：${st.devices.map(deviceName).join("、")}` : "まだつないでいる端末はありません。";
    const warnings = st.warnings.map((w) => `※ ${w}`);
    const others = st.urls.slice(1);
    ui.info.textContent = [
      `iPad などの Safari で ${st.urls[0]} を開いてください。`,
      ...(others.length ? [`（つながらないときは：${others.join(" / ")}）`] : []),
      // iPad に入れる証明書が、途中ですり替えられていないか見比べるため
      `証明書のフィンガープリント（SHA-256）：${st.caFingerprint}`,
      devices, ...warnings,
    ].join("\n");
    ui.btnRevoke.disabled = !st.devices.length;
  }

  function showMessage(text) {
    clearInterval(pollTimer);
    ui.code.textContent = text;
  }

  // 番号を表示して、iPad でつながるか、期限が切れるまで様子を見る
  function showCode(code, expiresAt, devicesBefore) {
    const draw = () => {
      const b = document.createElement("b");
      b.textContent = code;
      ui.code.replaceChildren(b, `iPad で入れてください（あと ${fmtLeft(expiresAt - Date.now())}）`);
    };
    const check = async () => {
      const st = await getStatus();
      if (st && st.devices.length > devicesBefore) {
        render(st);
        const added = st.devices.slice(devicesBefore).map(deviceName).join("、");
        return showMessage(`つながりました：${added}。心当たりのない端末なら「すべて解除」を押してください。`);
      }
      if (st && !st.pending) return showMessage("番号が使えなくなりました（期限切れか、間違いが多かったため）。もう一度表示してください。");
      draw();
    };
    clearInterval(pollTimer);
    draw();
    pollTimer = setInterval(check, POLL_MS);
  }

  ui.btnCode.onclick = async () => {
    try {
      const before = (await getStatus())?.devices.length ?? 0;
      const r = await fetch("/api/lan/code", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      showCode(j.code, j.expiresAt, before);
    } catch (e) { showMessage("番号を表示できませんでした：" + e.message); }
  };

  ui.btnRevoke.onclick = async () => {
    if (!confirm("つないでいる端末をすべて解除しますか？\nもう一度使うときは、ペアリングし直しが必要です。")) return;
    try {
      const r = await fetch("/api/lan/revoke", { method: "POST" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      showMessage("すべての端末の接続を解除しました。");
    } catch (e) { showMessage("解除できませんでした：" + e.message); }
    render(await getStatus());
  };

  getStatus().then(render);
  // サーバーを起動し直した直後は、LAN の準備が画面より少し遅れるので、設定を開いたときにも取り直す
  ui.row.closest("details")?.addEventListener("toggle", (e) => { if (e.target.open) getStatus().then(render); });
})();
