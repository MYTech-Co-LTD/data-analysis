#!/usr/bin/env bash
# scripts/guard-plugin-registry.sh
# 守护插件注册铁律（spec 2026-08-11-modular-plugin-design §4.2 注册表插件 / §5 目录即模块）：
#   新插件 = 新目录 + 注册表追加 1 行。目录建了但注册表未引用 → 宿主永远看不见（死代码）。
#   本 guard 把「软约定」升级为「硬约束」：新 collector/job/board 被迫合规（建目录的同时必须注册）。
#
# 三大插件域（目录 → 注册表）：
#   web/lib/collectors/<source>/           → web/lib/collectors/registry.ts（COLLECTORS: kind → collector）
#   web/lib/jobs/<job>/                    → web/lib/jobs/registry.ts（JOBS: JobManifest[]）
#   web/lib/report-center/boards/<board>/  → web/lib/report-center/boards/registry.ts（BOARDS: BoardManifest[]）
#
# 注册判定（保守，宁可漏报不误报）：
#   collectors：registry 出现 `"<id>":` 或 `<id>:` 键（COLLECTORS 对象键）
#   jobs / boards：registry 出现 `'./<id>/manifest'` 或 `"./<id>/manifest"` import（宿主 import 即注册）
#
# 非插件项（扫描排除）：registry/env/state（宿主自身文件，-type d 天然排除）+ shared/_shared/__tests__ 等共享/测试目录。
#
# 白名单：scripts/guard-plugin-registry.allowlist，每行 path，# 开头为注释。
# 白名单语义：命中的目录整目录豁免（该插件允许暂不注册——仅限架构 owner 明确 approve 的合理例外）。
# 默认拒绝——不要随意添加；新插件必须注册，白名单不是绕过注册的常规通道。
#
# 退出码：0 通过；1 违反。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

ALLOWLIST="$SCRIPT_DIR/guard-plugin-registry.allowlist"
hit=0
violations=""

# 非插件目录名（共享/测试目录，不是插件；registry/env/state 是文件，find -type d 已天然排除，这里兜底同名目录）
EXCLUDE_DIRS='^(registry|env|state|shared|_shared|__tests__|__mocks__|common|_common)$'

# 白名单：命中的目录整目录豁免（支持行内 # 注释，同 guard-branch-num.sh 语义）
is_allowlisted() {
  local dir="$1" dir_esc
  [ -f "$ALLOWLIST" ] || return 1
  dir_esc="${dir//\//\\/}"
  dir_esc="${dir_esc//./\\.}"
  grep -qE "^${dir_esc}(\s|\$|#)" "$ALLOWLIST" 2>/dev/null
}

report() {
  local dir="$1" label="$2"
  echo "❌ $dir 未在 $label 注册（新插件必须注册，宿主才能看见它）"
  violations="${violations}$dir 未注册\n"
  hit=1
}

# 注册判定：collectors 按 COLLECTORS 对象键；jobs/boards 按 `./<id>/manifest` import
is_registered() {
  local registry="$1" id="$2"
  if [[ "$registry" == *"/collectors/registry.ts" ]]; then
    grep -qE "(^|[[:space:],{])['\"]?${id}['\"]?[[:space:]]*:" "$registry" || return 1
  else
    grep -qF "'./${id}/manifest'" "$registry" || grep -qF "\"./${id}/manifest\"" "$registry" || return 1
  fi
}

# 扫描单个插件域：root 下每个一级子目录（插件目录）必须已注册
scan_domain() {
  local root="$1" registry="$2" label="$3"
  [ -d "$root" ] || return 0
  echo "[guard] 扫描 $root/*（$label 目录，须在 $registry 注册）..."
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    local id
    id="$(basename "$dir")"
    if [[ "$id" =~ $EXCLUDE_DIRS ]]; then
      echo "[guard]   跳过非插件目录 $dir"
      continue
    fi
    if is_allowlisted "$dir"; then
      echo "[guard]   白名单豁免 $dir"
      continue
    fi
    if ! is_registered "$registry" "$id"; then
      report "$dir" "$label"
    fi
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
}

scan_domain "web/lib/collectors"        "web/lib/collectors/registry.ts"        "collector"
scan_domain "web/lib/jobs"              "web/lib/jobs/registry.ts"              "job"
scan_domain "web/lib/report-center/boards" "web/lib/report-center/boards/registry.ts" "board"

if [ "$hit" -ne 0 ]; then
  echo "[guard] ❌ 发现未注册插件（新插件必须注册：建目录同时 registry 追加 1 行，宿主才能加载）"
  echo "[guard] 违规清单："
  echo -e "$violations"
  echo "[guard] 如属合理例外（架构 owner approve），在 scripts/guard-plugin-registry.allowlist 加目录并写理由（默认拒绝）"
  exit 1
fi
echo "[guard] ✅ 通过：全部插件均已注册"
