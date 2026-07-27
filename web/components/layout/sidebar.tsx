"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

const menuItems = [
  { id: "reports", label: "报表中心", icon: LayoutDashboard, href: "/" },
] as const;

// 报表中心 sidebar：默认收起为极窄边（w-6，无 icon），垂直中间一个箭头（ChevronRight）点击展开。
// 展开后 w-64 显菜单，箭头变 ChevronLeft（收起）。localStorage 记住偏好。
export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("sidebarOpen");
    if (saved !== null) setOpen(saved === "true");
    setMounted(true);
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem("sidebarOpen", String(next));
  };

  return (
    <aside
      className={cn(
        "border-r border-slate-200 bg-slate-50 min-h-[calc(100vh-64px)] transition-[width] duration-150 ease-in-out",
        open ? "w-64" : "w-6",
      )}
    >
      {open ? (
        <nav className="p-2">
          <button
            type="button"
            onClick={toggle}
            aria-label="收起侧边栏"
            className="flex w-full items-center rounded-md px-3 py-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <ChevronLeft size={16} strokeWidth={1.5} />
          </button>
          {menuItems.map((item) => {
            const Icon = item.icon;
            const active = mounted && (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href));
            return (
              <Link
                key={item.id}
                href={item.href}
                title={item.label}
                className={cn(
                  "flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-slate-200 text-slate-900"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
                )}
              >
                <Icon size={18} strokeWidth={1.5} className="shrink-0" />
                <span className="ml-2 truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-label="展开侧边栏"
          className="flex h-full w-full items-center justify-center text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <ChevronRight size={16} strokeWidth={1.5} />
        </button>
      )}
    </aside>
  );
}
