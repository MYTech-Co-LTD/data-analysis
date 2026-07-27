"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const menuItems = [
  { id: "reports", label: "报表中心", icon: <LayoutDashboard size={18} strokeWidth={1.5} /> },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-64 border-r border-slate-200 bg-slate-50 min-h-[calc(100vh-64px)]">
      <nav className="p-4 space-y-2">
        {menuItems.map((item) => {
          const active = pathname === "/";
          return (
            <Link
              key={item.id}
              href="/"
              className={cn(
                "flex w-full items-center justify-start rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active ? "bg-slate-200 text-slate-900" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
              )}
            >
              <span className="mr-2 text-slate-500">{item.icon as ReactNode}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
