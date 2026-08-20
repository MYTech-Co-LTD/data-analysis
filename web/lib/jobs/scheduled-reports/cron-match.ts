// web/lib/jobs/scheduled-reports/cron-match.ts
// cron_spec 匹配（spec §5）：结构化频率，业务人员不见 cron 表达式。
// 当日补发语义由 job 侧实现：
//   matchesDate 只判「该日是否 due」（纯日期，time 不参与）；
//   isTimeReached 判「当前时刻是否已过配置的 time」（当日补发：错过整点下一小时补上，跨日不补）——
//   job 每小时扫，「今日 due 且已过 time 且 last_run_date < 今天」即触发。

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

/**
 * 当前时刻是否已过配置的 time（当日补发：错过整点下一小时补上，跨日不补）。
 * 畸形/越界 time 视为无时间约束（返回 true，不阻塞）——创建侧已收紧（push-configs 路由 Fix 2b），
 * 此处只兜底历史脏数据：宁可按无时间约束跑，不可因脏 time 让任务永远不触发。
 */
export function isTimeReached(spec: CronSpec, now: Date): boolean {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(spec.time);
  if (!m) return true; // 缺失/畸形 time 视为无时间约束（创建侧已收紧，见 Fix 2b）
  const specMin = Number(m[1]) * 60 + Number(m[2]);
  return now.getHours() * 60 + now.getMinutes() >= specMin;
}

/** 管理页「下次触发」显示 */
export function nextRunLabel(spec: CronSpec, _from: Date): string {
  switch (spec.kind) {
    case 'daily': return `每天 ${spec.time}`;
    case 'weekly': return `每${WEEKDAYS[(spec.weekday ?? 1) - 1]} ${spec.time}`;
    case 'monthly': return `每月${spec.day}日 ${spec.time}`;
  }
}
