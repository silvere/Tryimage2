#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/jingweisun/Code/Tryimage2"
LOG_DIR="$HOME/Library/Logs/Tryimage2Scheduler"
PROMPT_FILE="$LOG_DIR/prompt.md"
LAST_MESSAGE="$LOG_DIR/last-message.md"
RUN_LOG="$LOG_DIR/run.log"

mkdir -p "$LOG_DIR"

cat > "$PROMPT_FILE" <<'PROMPT'
这是 Tryimage2 的 6 小时定时选题任务。

请执行：
1. 使用 image-gallery-publisher 的选题前流程，但不要生成图片。
2. 先读取 /Users/jingweisun/Code/Tryimage2/process.md 和 /Users/jingweisun/Code/Tryimage2/assets/gallery.json，理解已画主题、避重复原则、上一轮复盘。
3. 联网搜索最新新闻热点、行业时事、人类知识体系和认知热点，优先找有现实热度、有知识纵深、适合做 10-15 张系列图的“以小见大”主题。
4. 把本轮调研信号、至少 3 个候选主题、每个主题的“小切口 / 大问题 / 可做 10-15 张 / 避重复”追加记录到 process.md。
5. 最终回复只给本轮候选主题选项和简短判断，不要调用 image_gen，不要导入图库，不要发布。等用户选择后再进入图片生成。
PROMPT

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') Tryimage2 scheduler start ====="
  cd "$ROOT"
  /opt/homebrew/bin/codex exec resume --last --full-auto -o "$LAST_MESSAGE" - < "$PROMPT_FILE"
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') Tryimage2 scheduler done ====="
} >> "$RUN_LOG" 2>&1

if command -v osascript >/dev/null 2>&1; then
  /usr/bin/osascript -e 'display notification "Tryimage2 新一轮候选主题已生成，请查看 Codex 会话或 logs/tryimage2-scheduler/last-message.md" with title "Tryimage2 定时选题"'
fi
