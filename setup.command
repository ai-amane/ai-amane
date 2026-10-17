#!/bin/bash
# AI あまね かんたんセットアップ（Mac）。Finder でダブルクリックするか、ターミナルで ./setup.command
#  Node.js・Python・Claude Code を調べて、足りなければ入れる。そのあと scripts/setup.js に引き継ぐ。
#  --check: 調べるだけ（何も入れない）。引数は scripts/setup.js にもそのまま渡す。
cd "$(dirname "$0")" || exit 1
printf '\033]0;AI AMANE setup\007'

CHECK=0
for a in "$@"; do [ "$a" = "--check" ] && CHECK=1; done

pause_close() { read -r -p "Enter を押すと閉じます…"; }

# 手で入れる案内を出して止まる（名前・公式のページ）
stop_setup() {
  echo
  echo "[失敗] $1 を入れられませんでした。"
  echo "  手で入れる場合は、README の 3-0 の「Mac で手で入れる場合」を見てください。"
  echo "  公式のページ: $2"
  pause_close
  exit 1
}

# 入れたあとに、この窓の PATH を読み直す（窓を開き直さなくても続けられるように）
refresh_path() {
  local d
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    case ":$PATH:" in
      *":$d:"*) ;;
      *) [ -d "$d" ] && PATH="$d:$PATH" ;;
    esac
  done
  export PATH
}

node_ok() {
  local m
  command -v node >/dev/null 2>&1 || return 1
  m=$(node -v 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p')
  [ -n "$m" ] && [ "$m" -ge 18 ]
}

# python3.12 → 3.11 → 3.10 の順に、最初にあるもの。/usr/bin/python3 は呼ばない
# （コマンドライン・デベロッパ・ツールが無い Mac では、入れるかを聞く窓が出てしまうため）
find_py() {
  local p
  PY=""
  for p in python3.12 python3.11 python3.10; do
    if command -v "$p" >/dev/null 2>&1; then PY="$p"; return 0; fi
  done
  return 1
}

# 最新の LTS の版（読めなければ固定の版）
latest_node_lts() {
  local v
  v=$(curl -fsSL --max-time 15 https://nodejs.org/dist/index.json 2>/dev/null | grep -o '"version":"v[0-9.]*"[^}]*"lts":"[^"]*"' | head -1 | sed 's/^"version":"\(v[0-9.]*\)".*/\1/')
  case "$v" in
    v[0-9]*.[0-9]*.[0-9]*) echo "$v" ;;
    *) echo "v22.22.0" ;;
  esac
}

# 公式のインストーラー（.pkg）を落として開き、入れてもらう
install_pkg() {
  local name="$1" url="$2" dest="$HOME/Downloads/$3"
  echo "$name のインストーラーをダウンロードします…（$url）"
  curl -fL --progress-bar -o "$dest" "$url" || return 1
  open "$dest" || return 1
  echo "画面に従って入れてください（Mac のパスワードを聞かれます）。"
  read -r -p "入れ終わったら Enter を押してください…"
}

echo "=== AI あまね かんたんセットアップ（Mac） ==="
[ "$CHECK" = 1 ] && echo "（--check: 調べるだけです。何も入れません）"
refresh_path

# --- Node.js ---
if node_ok; then
  echo "Node.js: すでに入っています（$(node -v)）"
elif [ "$CHECK" = 1 ]; then
  echo "Node.js: 入れる予定です（brew があれば brew、なければ公式のインストーラー）"
else
  if command -v brew >/dev/null 2>&1; then
    echo "Node.js を入れます…（brew install node）"
    brew install node
  else
    V=$(latest_node_lts)
    echo "Node.js を入れます…（公式の $V）"
    install_pkg "Node.js" "https://nodejs.org/dist/$V/node-$V.pkg" "node-$V.pkg" || stop_setup "Node.js" "https://nodejs.org/ja"
  fi
  refresh_path; hash -r
  if node_ok; then echo "Node.js: 入れました（$(node -v)）"; else stop_setup "Node.js" "https://nodejs.org/ja"; fi
fi

# --- Python 3.10〜3.12 ---
if find_py; then
  echo "Python: すでに入っています（$($PY --version 2>&1)）"
elif [ "$CHECK" = 1 ]; then
  echo "Python: 入れる予定です（brew があれば brew、なければ公式のインストーラー）"
else
  if command -v brew >/dev/null 2>&1; then
    echo "Python を入れます…（brew install python@3.12）"
    brew install python@3.12
  else
    echo "Python 3.12 を入れます…（公式のインストーラー）"
    install_pkg "Python 3.12" "https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg" "python-3.12.10-macos11.pkg" || stop_setup "Python" "https://www.python.org/downloads/"
  fi
  refresh_path; hash -r
  # 公式のインストーラーは /usr/local/bin ではなく Frameworks に入れて、リンクを作る
  [ -d /Library/Frameworks/Python.framework/Versions/3.12/bin ] && PATH="/Library/Frameworks/Python.framework/Versions/3.12/bin:$PATH"
  if find_py; then echo "Python: 入れました（$($PY --version 2>&1)）"; else stop_setup "Python" "https://www.python.org/downloads/"; fi
fi

# --- Claude Code ---
if command -v claude >/dev/null 2>&1; then
  echo "Claude Code: すでに入っています（$(claude --version 2>/dev/null)）"
elif [ "$CHECK" = 1 ]; then
  echo "Claude Code: 入れる予定です（公式の install.sh）"
else
  echo "Claude Code を入れます…"
  curl -fsSL https://claude.ai/install.sh | bash
  refresh_path; hash -r
  PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
  if ! grep -qsF "$PATH_LINE" "$HOME/.zshrc"; then
    echo "$PATH_LINE" >> "$HOME/.zshrc"
    echo "  ~/.zshrc に、claude の場所（~/.local/bin）を足しました"
  fi
  if command -v claude >/dev/null 2>&1; then echo "Claude Code: 入れました"; else stop_setup "Claude Code" "https://code.claude.com/docs/en/setup"; fi
fi

# --- 残りの段（Node.js 側） ---
echo
if [ "$CHECK" = 1 ] && ! node_ok; then
  echo "Node.js が無いので、残りの段（.env・パッケージ・ログイン・AivisSpeech）は Node.js を入れてから調べます。"
  exit 0
fi
node scripts/setup.js "$@"
code=$?
# 10: この窓でそのまま あまね を起動する（Finder で開き直すと「開発元を検証できません」が出るのを避ける）
if [ "$code" -eq 10 ]; then exec /bin/bash ./start.command; fi
echo
pause_close
exit "$code"
