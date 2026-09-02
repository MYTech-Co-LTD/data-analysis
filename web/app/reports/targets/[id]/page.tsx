import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { getDeviceType } from "@/lib/get-device-type";
import { getClient } from "@/lib/api";
import { type GetterResult } from "@/lib/report-center/types";
import type { DataFreshness } from "@/lib/report-center/freshness";
import { formatFreshnessChina } from "@/lib/report-center/freshness";
import { BOARDS } from "@/lib/report-center/boards/registry";
import { hasBoardPerm } from "@/lib/feature-perm";
import { getServerPermissions } from "@/lib/server-claims";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { PartialDegradeBanner } from "@/components/report-center/partial-degrade-banner";
import { PermissionBanner } from "@/components/report-center/permission-banner";
import { FreshnessStaleBanner } from "@/components/report-center/freshness-stale-banner";

export const dynamic = "force-dynamic";

// 空的 GetterResult（用于 allSettled rejected 兜底——getter 内部已 catch，
// 理论上不会 reject；这里防御性，确保不抛 unhandled promise rejection）。
function errResult(): GetterResult<unknown> {
  return { rows: [], status: "error" };
}

// 看板页（P4 注册表驱动）：读 BOARDS → Promise.allSettled 每个 serverGet → 渲染 board.Desktop/Mobile。
// PC Header+Sidebar，移动 Header only（参照 reports/[id]/layout.tsx）。
export default async function TargetDashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const targetId = Number(id);
  const isMobile = (await getDeviceType()) === "mobile";

  const client = await getClient();

  // M8（Task 3 review）：report_achievement_gen 的 total 行查询原先用
  // `if (!totalRows?.length) notFound()`——PostgREST error 时 totalRows===undefined → 误判 notFound。
  // 改为：try/catch + 显式 error 标记。
  //   - 查询成功 && rows===0 → notFound（目标真不存在）
  //   - 查询失败（error 抛出或 res.error）→ 不 notFound，标记 totalFailed=true，
  //     走降级渲染（只显示横幅，不渲染依赖 t 的 dashboard）
  //   - 查询成功 && rows>0 → 正常渲染
  let totalRows: Record<string, unknown>[] | null = null;
  let totalFailed = false;
  try {
    const res = await client.database
      .from("report_achievement_gen")
      .select("*")
      .eq("target_id", targetId)
      .eq("target_level", "total")
      .limit(1);
    if (res.error) {
      throw res.error;
    }
    totalRows = (res.data ?? null) as Record<string, unknown>[] | null;
  } catch (e) {
    console.error("report_achievement_gen total fetch failed:", e);
    totalFailed = true;
  }

  // 只有"查询成功且 total 行数为 0"才 notFound（目标真不存在）
  if (!totalFailed && !totalRows?.length) notFound();

  // 取数失败：不 notFound，渲染降级页（横幅 + Header/Sidebar 外壳保持一致）
  // M9：total 查询失败≠模块 getter 失败（模块 getter 根本没跑），不再显示 "N/7 个模块加载失败"
  //（错误计数无意义），改 variant="total-failed" 显示「看板数据加载失败」，保留重试。
  if (totalFailed || !totalRows?.length) {
    const fallback = (
      <div className={isMobile ? "p-4" : "p-6"}>
        <PartialDegradeBanner variant="total-failed" />
        <PermissionBanner />
      </div>
    );
    return isMobile ? (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="flex-1 px-3">{fallback}</main>
      </div>
    ) : (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <div className="flex">
          <Sidebar />
          <main className="flex-1">{fallback}</main>
        </div>
      </div>
    );
  }

  const t = totalRows[0] as {
    status: string;
    start_date: string;
    end_date: string;
    days_elapsed: number | null;
    total_days: number | null;
    name: string;
    [key: string]: unknown;
  };
  // 看板级能力过滤（用户要求：每个看板抽象成能力自由配给角色）：只渲染有权限的看板模块。
  // 无 token/解码失败 → permissions=[] → 默认全部隐藏（fail-open 软门禁：无权限看板不渲染，不阻塞整页）；
  // 但看板数据本身仍由 PostgREST RLS 按门店范围裁剪（数据安全不依赖本显示层过滤）。
  const perms = await getServerPermissions();
  const visibleBoards = BOARDS.filter((b) => hasBoardPerm(perms, b.id));

  // F1.2: Promise.allSettled + GetterResult——单 getter 失败不挂整页。
  // 各板块 serverGet 内部已 catch（返 status:'error'），allSettled 是双保险。
  const results = await Promise.allSettled(
    visibleBoards.map((board) =>
      // 透传目标周期（t 来自 RLS 可见的报表视图）：item-top 等 getter 不再直查 targets 底表，
      // 避免门店权限用户被 targets 的 branch RLS 挡掉 ALL 目标（PGRST116 → 整板加载失败）。
      board.serverGet(targetId, {
        startDate: t.start_date,
        endDate: t.end_date,
      }),
    ),
  );
  const outcome = (i: number) =>
    results[i].status === "fulfilled" ? results[i].value : errResult();

  // 统计失败模块数（getter 内部 catch 走 status:'error'；或 allSettled rejected）
  const failCount = results.filter(
    (r) =>
      r.status === "rejected" ||
      (r.status === "fulfilled" && r.value.status === "error"),
  ).length;

  // F5 数据新鲜度：get_data_freshness 返回行 { data_updated_at, last_query_at }。
  //   - data_updated_at：3 表最新 /compute 时间的最早（数据新旧，仅展示）
  //   - last_query_at：collect_tasks.last_run_at 心跳（系统活跃，陈旧告警据此）
  // RPC 失败/返 error → freshnessFailed=true → 顶部红色横幅「查询时间获取失败」而非「—」。
  let freshness: DataFreshness | null = null;
  let freshnessFailed = false;
  try {
    const fr = await client.database.rpc("get_data_freshness");
    if (fr.error) throw fr.error;
    const rows = (fr.data ?? []) as DataFreshness[];
    freshness = rows[0] ?? null;
  } catch (e) {
    console.error("get_data_freshness failed:", e);
    freshnessFailed = true;
  }

  // 计算时间进度
  const progress =
    t.days_elapsed && t.total_days ? t.days_elapsed / t.total_days : 0;

  // 提取月份
  const targetMonth = new Date(t.start_date).getMonth() + 1;

  const banner = (
    <>
      {failCount > 0 && (
        <PartialDegradeBanner failCount={failCount} total={visibleBoards.length} />
      )}
      {/* F5：最近查询停留超 6h（系统停）→ 红色横幅；数据旧（源头没数据）不告警 */}
      <FreshnessStaleBanner
        lastQueryAt={freshness?.last_query_at}
        failed={freshnessFailed}
      />
      {/* F2.2：限门店用户（如店长）RLS 裁剪提示——内部 fetch /api/me 自判显隐 */}
      <PermissionBanner />
    </>
  );

  // 头部（标题/日期/数据新鲜度）——原 desktop/mobile 组件内头部上移到宿主，isMobile 差异用类切换
  const header = (
    <>
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
      >
        <ArrowLeft size={14} strokeWidth={1.5} />
        报表中心
      </Link>
      <div className="mt-1 flex items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-800 md:text-xl">
          {t.name}
        </h1>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            t.status === "active"
              ? "bg-blue-50 text-blue-700"
              : "bg-slate-100 text-slate-500"
          }`}
        >
          {t.status === "active" ? "进行中" : "已结束"}
        </span>
      </div>
      <div className="mt-0.5 text-xs tabular-nums text-slate-400">
        {t.start_date} ~ {t.end_date}
        {freshnessFailed ? (
          <> · 更新时间获取失败</>
        ) : (
          <>
            {" · 数据更新 "}
            {formatFreshnessChina(freshness?.data_updated_at) ?? "—"}
            {" · 最近查询 "}
            {formatFreshnessChina(freshness?.last_query_at) ?? "—"}
          </>
        )}
      </div>
    </>
  );

  // F1.3：透传 GetterResult（不提前解包 .rows），组件级 status='error' 显示模块失败占位。
  // 注册表驱动渲染：grid 布局保原视觉——全宽板块各自 md:col-span-2（见各板块 adapter），
  // 供应链+批发各半格并排（adapter 内保留旧 desktop.tsx 的滚动结构）。
  const boards = (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5">
      <div
        className={`md:col-span-2 ${
          isMobile
            ? "sticky top-0 z-20 border-b border-slate-200 bg-white px-4 py-3"
            : ""
        }`}
      >
        {header}
      </div>
      {visibleBoards.map((board, i) => {
        const Comp = isMobile ? (board.Mobile ?? board.Desktop) : board.Desktop;
        return (
          <Comp
            key={board.id}
            result={outcome(i)}
            target={t}
            targetId={targetId}
            progress={progress}
            targetMonth={targetMonth}
            isMobile={isMobile}
            permissions={perms}
          />
        );
      })}
      {visibleBoards.length === 0 && (
        <div className="md:col-span-2 rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
          你没有可查看的看板模块——请联系管理员分配看板能力
        </div>
      )}
    </div>
  );

  // 外壳：PC Header + Sidebar，移动 Header only（不要丢 Header）
  if (isMobile) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="flex-1 px-3">
          {banner}
          {boards}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1">
          <div className="p-6">
            {banner}
            {boards}
          </div>
        </main>
      </div>
    </div>
  );
}
