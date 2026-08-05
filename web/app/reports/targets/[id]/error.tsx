'use client';
import { getUserFriendlyMessage, isRetryable } from '@/lib/error';

export default function ReportError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const msg = getUserFriendlyMessage(error);
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
      <div className="text-red-600 text-3xl">⚠️</div>
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
