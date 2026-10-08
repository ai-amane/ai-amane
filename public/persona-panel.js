// 画面の「AI の設定」（名前・呼び方・話し方・キャラクター・守ること・あなたについて・返事の長さ）
//  サーバーの /api/persona に保存する（lib/persona.js）。保存すると、返答中でなければすぐ頭（Claude Code）に反映される
//  変えられるのは PC の画面からだけ（iPad などでは見るだけ）
window.AmanePersona = (() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const ui = {
    aiName: $("personaAiName"), userName: $("personaUserName"), preset: $("personaPreset"), btnPreset: $("btnPersonaPreset"),
    style: $("personaStyle"), length: $("personaLength"), character: $("personaCharacter"), rules: $("personaRules"), profile: $("personaProfile"),
    save: $("btnPersonaSave"), reset: $("btnPersonaReset"), note: $("personaNote"),
  };
  const FIELDS = ["aiName", "userName", "style", "length", "character", "rules", "profile"];
  let defaults = null, presets = [], saved = null, onSaved = () => {};

  const note = (t) => { ui.note.textContent = t; };
  const fill = (p) => { for (const k of FIELDS) ui[k].value = p?.[k] ?? ""; };
  const read = () => Object.fromEntries(FIELDS.map((k) => [k, ui[k].value]));

  async function load() {
    try {
      const r = await fetch("/api/persona");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      defaults = j.defaults; presets = j.presets || []; saved = j.persona;
      fill(saved);
      ui.preset.replaceChildren(...presets.map((p) => Object.assign(document.createElement("option"), { value: p.id, textContent: p.name })));
      for (const [k, max] of Object.entries(j.limits || {})) if (ui[k]) ui[k].maxLength = max;
      if (!j.editable) {
        for (const k of [...FIELDS, "preset", "btnPreset", "save", "reset"]) ui[k].disabled = true;
        note("AI の設定は、PC の画面で変えてください（この画面では見るだけです）。");
      }
    } catch (e) { note("AI の設定を読めません: " + e.message); }
  }

  async function save() {
    ui.save.disabled = true;
    try {
      const r = await fetch("/api/persona", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(read()) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      const renamed = saved && saved.aiName !== j.persona.aiName;
      saved = j.persona;
      fill(saved);
      onSaved(saved);
      note("保存しました。返事をしていなければ、すぐ反映します（それまでの会話の続きは忘れます）。"
        + (renamed ? `名前で呼びかけるときは、設定の「呼びかけの言葉」に「${saved.aiName}」を足してください。` : ""));
    } catch (e) { note("保存できません: " + e.message); }
    finally { ui.save.disabled = false; }
  }

  // onSaved(persona): 保存したとき（app.js は会話ログの名前などを変える）
  function init(handler = () => {}) {
    onSaved = handler;
    if (!ui.save) return;
    ui.save.onclick = save;
    ui.btnPreset.onclick = () => {
      const p = presets.find((x) => x.id === ui.preset.value);
      if (p) { ui.style.value = p.style; note(`「${p.name}」の話し方を入れました。「保存して反映」で使えるようになります。`); }
    };
    ui.reset.onclick = () => {
      if (!defaults) return;
      fill(defaults);
      note("最初の設定を入れました。「保存して反映」で使えるようになります。");
    };
    load();
  }

  return { init, reload: load };
})();
