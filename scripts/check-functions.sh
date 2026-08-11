#!/usr/bin/env bash
# scripts/check-functions.sh
# Edge Function 本地校验脚本
# 检查所有 function 的语法和基本结构

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FUNCTIONS_DIR="$ROOT/functions"

if [ ! -d "$FUNCTIONS_DIR" ]; then
  echo "❌ functions 目录不存在"
  exit 1
fi

errors=0
total=0

echo "🔍 检查 Edge Functions..."
echo ""

for dir in "$FUNCTIONS_DIR"/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")

  # _shared 是共享模块目录（非 function），由下方 bundle 校验环节间接校验，跳过入口检查
  if [ "$name" = "_shared" ]; then
    continue
  fi

  # 支持 .js 和 .ts
  js_file="$dir/index.js"
  ts_file="$dir/index.ts"
  
  total=$((total + 1))

  # 检查入口文件是否存在
  if [ ! -f "$js_file" ] && [ ! -f "$ts_file" ]; then
    echo "❌ $name: 缺少 index.js 或 index.ts"
    errors=$((errors + 1))
    continue
  fi

  # 选择存在的文件
  file="$js_file"
  [ -f "$js_file" ] || file="$ts_file"

  # JavaScript 语法检查
  if [[ "$file" == *.js ]]; then
    if ! node -c "$file" 2>/dev/null; then
      echo "❌ $name: 语法错误"
      node -c "$file" 2>&1 | head -3
      errors=$((errors + 1))
      continue
    fi
    
    # 检查是否有 module.exports (Node.js Edge Function)
    if ! grep -qE "module.exports" "$file"; then
      echo "⚠️  $name: 缺少 module.exports"
    fi
  fi

  # TypeScript 文件检查导出或 serve (Deno Edge Function)
  if [[ "$file" == *.ts ]]; then
    if ! grep -qE "export|serve\(" "$file"; then
      echo "❌ $name: TypeScript 文件缺少导出或 serve"
      errors=$((errors + 1))
      continue
    fi
  fi

  echo "✅ $name"
done

# ---- 共享打包（P3 铺开，全 5 个引用 function）：_shared bundle 产物校验 ----
# 引用 ../_shared 的 function 必须能经 esbuild 打出合法单文件 CJS（部署产物），
# 并对已提交的 index.bundle.js（服务器无 node/npx 时的回退产物）做 node --check。
BUNDLE_DIR="$ROOT/.bundle"
mkdir -p "$BUNDLE_DIR"
for dir in "$FUNCTIONS_DIR"/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  [ "$name" = "_shared" ] && continue
  js_file="$dir/index.js"
  [ -f "$js_file" ] || continue
  grep -qE "require\(['\"]\.\./_shared/" "$js_file" || continue

  echo "🔎 $name: 共享打包 bundle 校验..."
  committed="$dir/index.bundle.js"
  if command -v npx >/dev/null 2>&1; then
    fresh="$BUNDLE_DIR/$name.js"
    if ! npx --yes esbuild "$js_file" --bundle --format=cjs --log-level=warning --outfile="$fresh" >/dev/null 2>&1; then
      echo "❌ $name: esbuild bundle 失败（_shared 无法内联）"
      errors=$((errors + 1))
    else
      if ! node --check "$fresh" 2>/dev/null; then
        echo "❌ $name: 现场 bundle 产物语法错误（.bundle/$name.js）"
        node --check "$fresh" 2>&1 | head -3
        errors=$((errors + 1))
      else
        echo "  ✅ $name: 现场 bundle 合法单文件 CJS（_shared 已内联）"
      fi
      # 已提交回退产物同样校验（服务器无 node/npx 时用它部署）
      if [ -f "$committed" ]; then
        if node --check "$committed" 2>/dev/null; then
          echo "  ✅ $name: index.bundle.js 语法合法"
        else
          echo "❌ $name: index.bundle.js 语法错误"
          node --check "$committed" 2>&1 | head -3
          errors=$((errors + 1))
        fi
        # 漂移门禁：服务器无 node/npx，只能部署已提交的 index.bundle.js。
        # 源码改动后若未重新生成并提交 bundle，部署的会是旧代码 → 直接判失败，强制重新生成。
        if ! cmp -s "$fresh" "$committed"; then
          echo "❌ $name: index.bundle.js 与源码最新 bundle 不一致（需重新生成并提交）"
          echo "   请运行: npx esbuild $js_file --bundle --format=cjs --outfile=$committed"
          errors=$((errors + 1))
        fi
      fi
    fi
  elif [ -f "$committed" ]; then
    if node --check "$committed" 2>/dev/null; then
      echo "  ✅ $name: index.bundle.js 语法合法（无 npx，用已提交产物）"
    else
      echo "❌ $name: index.bundle.js 语法错误"
      node --check "$committed" 2>&1 | head -3
      errors=$((errors + 1))
    fi
  else
    echo "❌ $name: 引用 _shared 但无 npx 且无 index.bundle.js，无法校验/部署"
    errors=$((errors + 1))
  fi
done

echo ""
echo "📊 检查完成: $total 个 function，$errors 个错误"

[ "$errors" -eq 0 ] || exit 1
