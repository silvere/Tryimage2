#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="/Users/jingweisun/Code/Tryimage2"
LOG_DIR="$HOME/Library/Logs/Tryimage2Scheduler"
PROMPT_FILE="$LOG_DIR/prompt.md"
LAST_MESSAGE="$LOG_DIR/last-message.md"
RUN_LOG="$LOG_DIR/run.log"
LOCK_DIR="$LOG_DIR/lock"

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') Tryimage2 scheduler skipped: previous run still active =====" >> "$RUN_LOG"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

cat > "$PROMPT_FILE" <<'PROMPT'
这是 Tryimage2 的 6 小时定时选题任务。

请执行：
1. 使用 image-gallery-publisher 的选题前流程，但不要生成图片。
2. 先读取 /Users/jingweisun/Code/Tryimage2/process.md 和 /Users/jingweisun/Code/Tryimage2/assets/gallery.json，理解已画主题、避重复原则、上一轮复盘。
3. 联网搜索最新新闻热点、行业时事、人类知识体系和认知热点，优先找有现实热度、有知识纵深、适合做 10-15 张系列图的“以小见大”主题。
4. 把本轮调研信号、至少 3 个候选主题、每个主题的“小切口 / 大问题 / 可做 10-15 张 / 避重复”追加记录到 process.md。
5. 最终回复只给本轮候选主题选项和简短判断，不要调用 image_gen，不要导入图库，不要发布。等用户选择后再进入图片生成。
6. 最终回复末尾明确写一句：请回到当前 Tryimage2 会话回复主题编号或主题名，我再开始画图。
PROMPT

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') Tryimage2 scheduler start ====="
  cd "$ROOT"
  /opt/homebrew/bin/codex --search exec --ephemeral --full-auto -C "$ROOT" -o "$LAST_MESSAGE" - < "$PROMPT_FILE"
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') Tryimage2 scheduler done ====="
} >> "$RUN_LOG" 2>&1

if command -v osascript >/dev/null 2>&1; then
  /usr/bin/osascript -e 'display notification "新一轮候选主题已准备。请回到当前 Tryimage2 会话回复编号或主题名，我再开始画图。" with title "Tryimage2 等待选题"'
fi
