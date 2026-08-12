#!/usr/bin/env bash
# scripts/setup-hooks.sh
# 手动设置 Git hooks（需要执行一次）

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 兼容 worktree（.git 为 gitdir 指针文件）与普通仓库：
# `git rev-parse --git-path hooks` 返回当前 worktree 实际生效的 hooks 目录。
if HOOKS_DIR="$(git -C "$ROOT" rev-parse --git-path hooks 2>/dev/null)" && [ -n "$HOOKS_DIR" ]; then
  :
else
  HOOKS_DIR="$ROOT/.git/hooks"
fi
mkdir -p "$HOOKS_DIR"

echo "🔧 设置 Git pre-commit hook（$HOOKS_DIR/pre-commit）..."

cat > "$HOOKS_DIR/pre-commit" << 'HOOK'
#!/usr/bin/env bash
set -e

echo "🔍 Running lint-staged..."
cd web && npx lint-staged

echo "🔍 Checking edge functions..."
cd .. && bash scripts/check-functions.sh

echo "🔍 Guard: contract drift (jobs ⇄ boards 禁止互 import)..."
bash scripts/guard-contract-drift.sh

echo "🔍 Guard: plugin registry (新插件必须注册)..."
bash scripts/guard-plugin-registry.sh

echo "✅ Pre-commit checks passed"
HOOK

chmod +x "$HOOKS_DIR/pre-commit"

echo "✅ Git hooks 已设置完成"
echo ""
echo "现在每次 git commit 都会自动运行："
echo "  - lint-staged (检查修改的 ts/tsx 文件)"
echo "  - check-functions.sh (检查 edge functions)"
echo "  - guard-contract-drift.sh (jobs ⇄ boards 禁止互 import)"
echo "  - guard-plugin-registry.sh (新插件必须注册)"
