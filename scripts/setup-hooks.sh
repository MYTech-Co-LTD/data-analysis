#!/usr/bin/env bash
# scripts/setup-hooks.sh
# 就位/检查本仓库的 pre-commit 检查（项目级，随仓库走）
#
# 历史成因（保留以备后人）：
#   本脚本曾把项目检查写进 `git rev-parse --git-path hooks` 返回的目录。该命令会
#   尊重**全局** core.hooksPath，于是在设了全局 hooksPath 的机器上，这些项目检查
#   被写进了全局 hooks 目录 → 机器上其他仓库的提交全部失败（且本仓库自己也会因
#   引用不存在的 guard-migration-spec.sh 而失败）。
#
# 现行约定：
#   - 项目检查常驻 <repo>/.dev-workflow/pre-commit（提交进仓库，新克隆即生效）
#   - 全局目录只放调度器 + commit-msg（由 dev-workflow-infra 的 install.sh 部署）

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/.dev-workflow/pre-commit"
GLOBAL_HOOKS="$(git config --global core.hooksPath || true)"
DISPATCHER="${GLOBAL_HOOKS:-$HOME/.git/hooks}/pre-commit"

echo "🔧 data-analysis pre-commit 检查"
echo "   项目 hook: $HOOK"

if [ ! -f "$HOOK" ]; then
  echo "❌ 缺少 $HOOK —— 请从仓库恢复：git checkout -- .dev-workflow/pre-commit"
  exit 1
fi
chmod +x "$HOOK"
echo "   ✅ 可执行位已就位"

if [ -n "$GLOBAL_HOOKS" ] && [ -f "$DISPATCHER" ]; then
  echo "   ✅ 全局调度器已就位: $DISPATCHER"
  echo "      (core.hooksPath=$GLOBAL_HOOKS)"
else
  echo "   ⚠️  未找到全局调度器: $DISPATCHER"
  echo "      请先执行 dev-workflow-infra 的 ./install.sh（部署全局 pre-commit 调度器 + commit-msg）"
fi

echo ""
echo "每次 git commit 将自动运行（由全局调度器按仓库调用）："
echo "  - lint-staged (web/ 下的 ts/tsx)"
echo "  - scripts/check-functions.sh"
echo "  - scripts/guard-contract-drift.sh"
echo "  - scripts/guard-plugin-registry.sh"
echo "  - scripts/guard-migration-spec.sh（该脚本存在时才跑）"
