// 呼びかけの言葉の欄を扱う、小さな関数（app.js から使う）
//  欄は「、」「,」で区切るので、足す言葉の中に句読点や空白があると 2 つに割れてしまう。
//  足すときに取り除く。呼びかけの判定（lib/wake.js）も同じ文字を取り除いて比べるので、これで合う
window.AmaneWakeWords = (() => {
  "use strict";
  const SEPARATORS = /[,、，]/;
  const NOISE = /[\s、。，．,.!！?？]/g;
  const splitList = (value) => String(value || "").split(SEPARATORS).map((w) => w.trim()).filter(Boolean);
  const cleanHeard = (text) => String(text || "").replace(NOISE, "");
  // 聞こえた言葉を足した新しい一覧を返す（元の一覧は変えない）
  const addHeard = (list, heard) => {
    const word = cleanHeard(heard);
    return !word || list.includes(word) ? [...list] : [...list, word];
  };
  return { splitList, cleanHeard, addHeard };
})();
