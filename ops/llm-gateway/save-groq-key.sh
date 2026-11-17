#!/bin/sh
# 把剪貼簿裡的 Groq key 存到 ~/.config/hub-llm/groq.key（600），存完清空剪貼簿；不印出 key。
set -eu
d="$HOME/.config/hub-llm"; f="$d/groq.key"
mkdir -p "$d"; chmod 700 "$d"
k=$(pbpaste | tr -d '\r\n ')
case "$k" in gsk_*) ;; *) echo "剪貼簿不是 Groq key（應以 gsk_ 開頭），沒有存。請重新複製 key 再跑。"; exit 1;; esac
umask 077; printf '%s' "$k" > "$f"; chmod 600 "$f"; unset k
printf '' | pbcopy
echo "saved: $(wc -c < "$f" | tr -d ' ') bytes, starts with $(cut -c1-4 "$f")"
