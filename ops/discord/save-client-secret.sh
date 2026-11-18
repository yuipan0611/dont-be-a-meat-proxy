#!/bin/sh
# 把剪貼簿裡的 Discord OAuth Client Secret 存到 ~/.config/hub-discord/client.secret（600），存完清空剪貼簿；不印出內容。
set -eu
d="$HOME/.config/hub-discord"; f="$d/client.secret"
mkdir -p "$d"; chmod 700 "$d"
k=$(pbpaste | tr -d '\r\n ')
case "$k" in *[!A-Za-z0-9_-]*|'') echo "剪貼簿內容不像 Client Secret，沒有存。請重新複製再跑。"; exit 1;; esac
[ ${#k} -ge 24 ] && [ ${#k} -le 64 ] || { echo "長度 ${#k} 不像 Client Secret（通常 32），沒有存。"; exit 1; }
umask 077; printf '%s' "$k" > "$f"; chmod 600 "$f"; unset k
printf '' | pbcopy
echo "saved: $(wc -c < "$f" | tr -d ' ') chars"
