import { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { LayoutDashboard, Package, Store, Target, Users, ExternalLink, Boxes, Layers, ListTree, ShieldCheck, ClipboardCheck } from 'lucide-react';
import { Toaster } from 'sonner';

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const cookieStore = await cookies();
  const wecomName = cookieStore.get('wecom_name')?.value || '管理员';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/dashboard" className="font-bold text-lg">
            数据分析平台
          </Link>
          <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
            管理后台
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{wecomName}</span>
          <Link href="/" className="text-sm text-primary hover:underline">
            返回前台
          </Link>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-[200px] bg-white border-r min-h-[calc(100vh-49px)]">
          <nav className="p-4 space-y-2">
            <NavItem href="/admin/dashboard" icon={<LayoutDashboard size={16} />}>仪表盘</NavItem>
            <div className="pt-2">
              <NavItem href="/admin/sources" icon={<Package size={16} />}>数据源</NavItem>
              <div className="ml-6 mt-1 space-y-1">
                <SubNavItem href="/admin/sources">配置</SubNavItem>
                <SubNavItem href="/admin/sources/tasks">采集任务</SubNavItem>
                <SubNavItem href="/admin/sources/monitor">监控面板</SubNavItem>
              </div>
            </div>
            <div className="pt-2">
              <NavItem href="/admin/branches" icon={<Store size={16} />}>门店维护</NavItem>
            </div>
            <div className="pt-2">
              <NavItem href="/admin/items" icon={<Boxes size={16} />}>商品维护</NavItem>
            </div>
            <div className="pt-2">
              <NavItem href="/admin/targets" icon={<Target size={16} />}>目标管理</NavItem>
            </div>
            <div className="pt-2">
              <NavItem href="/admin/semantic" icon={<Layers size={16} />}>语义层</NavItem>
            </div>
            <div className="pt-2">
              <NavItem href="/admin/qa" icon={<ClipboardCheck size={16} />}>数据质量</NavItem>
            </div>
            <div className="pt-4 border-t">
              <NavItem href="/admin/capabilities" icon={<ListTree size={16} />}>能力目录</NavItem>
              <NavItem href="/admin/scope" icon={<ListTree size={16} />}>数据范围总览</NavItem>
              <NavItem href="/admin/permissions" icon={<ShieldCheck size={16} />}>权限管理</NavItem>
              <a href="https://sso.shanhaiyiguo.com/login/shanhai" target="_blank" rel="noreferrer"
                 className="flex items-center gap-2 px-3 py-2 rounded text-sm text-slate-600 hover:bg-slate-100">
                <Users size={16} /> 用户管理（Casdoor）
                <ExternalLink size={12} className="text-slate-400" />
              </a>
            </div>
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 p-6">{children}</main>
      </div>
      <Toaster richColors position="top-center" />
    </div>
  );
}

function NavItem({ href, icon, children, disabled }: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span className="flex items-center gap-2 px-2 py-2 text-sm text-gray-400 cursor-not-allowed rounded-md">
        {icon}
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className="flex items-center gap-2 px-2 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">
      {icon}
      {children}
    </Link>
  );
}

function SubNavItem({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="block px-2 py-1 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md">
      {children}
    </Link>
  );
}
