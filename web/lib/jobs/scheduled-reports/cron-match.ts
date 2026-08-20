// web/lib/jobs/scheduled-reports/cron-match.ts
// cron_spec 匹配（spec §5）：结构化频率，业务人员不见 cron 表达式。
// 当日补发语义由 job 侧实现（matchesDate 只判「该日是否 due」，time 不参与——
//   job 每小时扫，「今日 due 且 last_run_date < 今天」即触发，跨日不补）。

export interface CronSpec {
  kind: 'daily' | 'weekly' | 'monthly';
  time: string;        // "HH:mm"
  weekday?: number;    // weekly：1-7（周一=1）
  day?: number;        // monthly：1-31
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 该日期是否 due（本地时区语义：用 getDay/getDate，服务器 TZ=Asia/Shanghai 部署） */
export function matchesDate(spec: CronSpec, d: Date): boolean {
  switch (spec.kind) {
    case 'daily':
      return true;
    case 'weekly': {
      // JS getDay(): 周日=0..周六=6 → 周一=1 起的 weekday
      const jsDay = d.getDay() === 0 ? 7 : d.getDay();
      return jsDay === spec.weekday;
    }
    case 'monthly': {
      const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (spec.day! > daysInMonth) return false; // 当月无该日（2月无31）→ 当月跳过
      return d.getDate() === spec.day;
    }
    default:
      return false;
  }
}

/** 管理页「下次触发」显示 */
export function nextRunLabel(spec: CronSpec, _from: Date): string {
  switch (spec.kind) {
    case 'daily': return `每天 ${spec.time}`;
    case 'weekly': return `每${WEEKDAYS[(spec.weekday ?? 1) - 1]} ${spec.time}`;
    case 'monthly': return `每月${spec.day}日 ${spec.time}`;
  }
}
