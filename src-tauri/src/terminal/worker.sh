# Arguments: the CLI executable and its literal arguments.
#
# 后台 worker 的监督脚本。和 session.sh 只差最后一屏：
# session.sh 退出后要落回一个交互式 shell（人还要继续用那个标签页），
# 而 worker 的 pane 必须跟着 CLI 一起结束——调度器靠「pane 已退出 / 消失」
# 判断 worker 停了，落回 shell 会让它永远看起来在跑。
#
# 退出码先记账再原样交回去：journal 是接棒与调度共用的唯一事实，
# zellij 的 pane 退出码只是第二条旁证（journal 写失败时还有的看）。
"$@"
phi_worker_status=$?
if [ -n "${PHI_BATON_JOURNAL-}" ] && [ -n "${PHI_BATON_ID-}" ]; then
  phi_worker_now=$(date +%s 2>/dev/null || echo 0)
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$PHI_BATON_ID" "$phi_worker_status" "$phi_worker_now" \
    "${PHI_BATON_APP-}" "$PWD" >>"$PHI_BATON_JOURNAL" 2>/dev/null || :
fi
exit "$phi_worker_status"
