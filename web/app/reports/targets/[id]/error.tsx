'use client';
import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getUserFriendlyMessage, isRetryable } from '@/lib/error';

export default function ReportError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // N1：与全局 app/error.tsx 一致——错误日志上报（生产可接 Sentry）。
  useEffect(() => {
    console.error('Report error:', error);
  }, [error]);

  const msg = getUserFriendlyMessage(error);
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
      <AlertTriangle size={32} strokeWidth={1.5} className="text-red-600" />
      <h2 className="text-lg font-semibold">报表加载失败</h2>
      <p className="text-sm text-slate-600">{msg}</p>
      {isRetryable(error) && (
        <button onClick={reset} className="rounded bg-blue-600 px-4 py-2 text-sm text-white">重试</button>
      )}
      {process.env.NODE_ENV === 'development' && (
        <pre className="text-xs text-slate-400">{error.message}</pre>
      )}
    </div>
  );
}
