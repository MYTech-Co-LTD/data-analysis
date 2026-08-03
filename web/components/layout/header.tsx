import { cookies, headers } from "next/headers";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { LogoutButton } from "@/components/layout/logout-button";
import { isWecomClient } from "@/lib/device";
import { isAdmin } from "@/lib/auth";
import { getDeviceType } from "@/lib/get-device-type";

// Header（server component）：在受保护页渲染，此时一定已登录（middleware 已拦截未登录）。
// 读 wecom_name / wecom_userid cookie（非 httpOnly）展示身份 + 退出按钮。
// 企微客户端内隐藏退出按钮（不允许退出）。
// 强制动态渲染，禁用缓存
export const dynamic = "force-dynamic";

export async function Header() {
  const cookiesList = await cookies();
  const name = cookiesList.get("wecom_name")?.value;
  const userid = cookiesList.get("wecom_userid")?.value;
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isWecom = isWecomClient(ua);
  const isMobile = (await getDeviceType()) === "mobile";

  // 优先显示姓名，fallback 到 userid
  const displayName = name || userid;

  return (
    <header className="border-b bg-white">
      <div className={`flex items-center justify-between ${isMobile ? "h-12 px-4" : "h-16 px-6"}`}>
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">数据分析平台</h1>
          {!isMobile && <Badge variant="secondary">Beta</Badge>}
        </div>
        <div className="flex items-center gap-4">
          {isAdmin(userid) && !isMobile && (
            <Link href="/admin/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
              管理后台
            </Link>
          )}
          {displayName ? (
            <div className="flex items-center gap-2">
              {!isMobile && <span className="text-sm text-muted-foreground">{displayName}</span>}
              <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium">
                {displayName[0]?.toUpperCase()}
              </div>
              {/* 企微客户端内隐藏退出按钮 */}
              {!isWecom && <LogoutButton />}
            </div>
          ) : (
            // 已登录但无用户名信息时显示提示（不应该发生）
            <span className="text-sm text-muted-foreground">已登录</span>
          )}
        </div>
      </div>
    </header>
  );
}
