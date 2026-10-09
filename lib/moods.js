// 声の気持ち（AivisSpeech のとき）
//  頭（Claude Code）が、気持ちが変わる文の頭に [うれしい] のような印を書く。画面（public/local-voice.js）がそれを読み取って
//  文ごとに送ってくるので、ここで AivisSpeech のスタイル・強さ・緩急・速さに置きかえる。
//  ・スタイルの名前はモデルごとに自由（まお は「からかい」「せつなめ」、ほかのモデルは「喜び」「Happy」など）なので、
//    気持ちごとに候補の名前を並べ、選んだ声と同じ話者の中から最初に見つかったものを使う。なければ選んだ声のまま
//  ・強さ（intonationScale）は、AivisSpeech では「スタイルの感情表現の強さ」。1〜2 が内部で 1〜10 倍の誇張になり、
//    2 に近いと声が崩れることがあるので 1.5 にする。全スタイルの平均（モデルの中の番号が 0）には効かない
//  ・高さ（pitchScale）は 0 以外にすると音質が落ちる（AivisSpeech の説明）ので変えない。代わりに緩急（tempoDynamicsScale）と速さを変える
//  ・数値は、聞き比べ（まお）でいちばん気持ちが伝わったもの

const STRENGTH = 1.5;   // スタイルを切り替えたときの強さ

// 気持ち → 候補のスタイル名（前のものほど優先。名前に含まれていればよい）・緩急・速さ（設定の速さに掛ける）
const MOODS = {
  ふつう:   { names: [], tempo: 1, speedFactor: 1, about: "ふだんの調子に戻す" },
  うれしい: { names: ["喜び", "うれしい", "嬉しい", "楽しい", "幸せ", "上機嫌", "じょうきげん", "テンション高め", "happy", "joy", "positive", "からかい"], tempo: 1.4, speedFactor: 1.06, about: "喜び・驚き・楽しさ" },
  からかう: { names: ["からかい", "いたずら", "ツンツン", "silly"], tempo: 1.2, speedFactor: 1, about: "冗談・軽いからかい" },
  やさしい: { names: ["あまあま", "やさしい", "優しい", "甘え", "穏やか"], tempo: 1, speedFactor: 0.91, about: "ねぎらい・励まし・甘え" },
  おちつく: { names: ["おちつき", "落ち着き", "calm", "クール", "穏やか"], tempo: 0.8, speedFactor: 0.91, about: "落ち着かせる・静かに伝える" },
  かなしい: { names: ["悲しみ", "かなしい", "悲しい", "せつなめ", "切ない", "sad", "sorrow", "なみだめ", "negative"], tempo: 0.8, speedFactor: 0.85, about: "残念・同情・さみしさ" },
};
const MOOD_NAMES = Object.keys(MOODS);

const isAverage = (styleId) => (Number(styleId) & 31) === 0;   // モデルの中の番号が 0（全スタイルの平均）
const isMood = (mood) => Object.hasOwn(MOODS, String(mood));
// スタイル名が候補の名前に合うか。英語は単語として合うときだけ（Unhappy を happy としない）、日本語は「不」「非」が前に付くものを除く（不幸せ）
function nameMatches(styleName, word) {
  const name = String(styleName).toLowerCase();
  if (/^[a-z]+$/.test(word)) return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(name);
  return name.includes(word) && !name.includes("不" + word) && !name.includes("非" + word);
}

// 選んだ声（speaker）と気持ちから、合成に使う声と強さ・緩急・速さの倍率を決める。speakers: AivisSpeech の /speakers の一覧
function resolveMood({ speakers, speaker, mood }) {
  const m = isMood(mood) ? MOODS[mood] : MOODS.ふつう;
  const group = (Array.isArray(speakers) ? speakers : []).find((sp) => sp?.styles?.some((st) => st.id === speaker));
  const styles = group?.styles || [];
  const found = m.names.map((n) => styles.find((st) => nameMatches(st.name, n))).find(Boolean);
  const id = found ? found.id : speaker;
  return { speaker: id, intonation: found && !isAverage(id) ? STRENGTH : 1, tempo: m.tempo, speedFactor: m.speedFactor };
}

// 頭への説明（AivisSpeech のときだけ、プロンプトの後ろに付ける）
function moodPrompt() {
  return [
    "# 声の気持ち",
    "あなたの声は、気持ちに合わせて調子を変えられる。気持ちがはっきり変わる文の頭にだけ、次の印を1つ書く（「記号は使わない」の例外）。印は読み上げられず、次の印まで続き、返事ごとに「ふつう」に戻る。",
    ...MOOD_NAMES.filter((n) => n !== "ふつう").concat("ふつう").map((n) => `- [${n}] ${MOODS[n].about}`),
    "ふだんの受け答えや、作業・情報を伝える文には書かない。1つの返事で2回まで。タグ（<task> など）の中には書かない。",
    "例: [うれしい]えっ、もう終わったんですか？[やさしい]今日はお疲れさまでした。",
  ].join("\n");
}

module.exports = { resolveMood, moodPrompt, isMood, MOOD_NAMES, MOODS };
