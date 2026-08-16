// web/lib/jobs/push-contract/manifest.ts
// S4 推送契约测试 job（plan Task 10）：每日 04:07 Asia/Shanghai 校验四条契约，红→collect_fail 告警。
// ① Novu 模板 {{payload.X}} ⊆ push_variables.enabled（模板变量白名单守卫）
// ② selector 引用存在性（dept/role IDs 须在 org_departments/roles 中存在）
// ③ role_codes 双向 diff（Casdoor 镜像 org_users.role_codes ↔ roles.code，含 admin 常量）
// ④ 时区断言（Novu workflow timezone 须 = Asia/Shanghai）
// 依赖方向铁律：仅消费 contracts（JobManifest/JobResult）、env、scheduler-lock、notifyWecom。
import type { JobManifest, JobResult } from '../../contracts';
import { notifyWecom } from '../../notify';
import { tryAcquireLock } from '../../scheduler-lock';
import { INSFORGE_API_KEY, POSTGREST_URL } from '../env';
import { runningTasks } from '../state';

const JOB_KEY = '__push_contract';

// ── 类型 ───────────────────────────────────────────────
interface ContractCheckResult {
  name: string;
  pass: boolean;
  detail: string;
  extra?: unknown;
}

// ── PostgREST 辅助 ─────────────────────────────────────
const PG_HEADERS = () => ({
  'Content-Type': 'application/json',
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
});

async function pgQuery<T>(path: string): Promise<T> {
  const r = await fetch(`${POSTGREST_URL}${path}`, { headers: PG_HEADERS() });
  if (!r.ok) throw new Error(`PostgREST ${path}: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json() as Promise<T>;
}

// ── Novu API 辅助 ──────────────────────────────────────
const NOVU_API_URL = (process.env.NOVU_API_URL ?? '').trim().replace(/\/+$/, '');
const NOVU_API_KEY = (process.env.NOVU_API_KEY ?? '').trim();

async function novuFetch<T>(path: string): Promise<T> {
  const r = await fetch(`${NOVU_API_URL}${path}`, {
    headers: { Authorization: `ApiKey ${NOVU_API_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`Novu ${path}: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json() as Promise<T>;
}

// ── Check 1: Novu 模板变量 ⊆ push_variables.enabled ───
async function checkNovuTemplateVars(): Promise<ContractCheckResult> {
  const name = 'novu_template_vars';
  if (!NOVU_API_URL || !NOVU_API_KEY) {
    return { name, pass: true, detail: 'Novu 未配置（NOVU_API_URL/NOVU_API_KEY 为空），跳过' };
  }
  try {
    // Novu v1 API: GET /v1/workflows 返回 notification templates 列表
    interface NovuWorkflow {
      _id: string;
      name: string;
      triggers: Array<{ identifier: string; variables?: Array<{ name: string }> }>;
      steps: Array<{
        template?: { content?: string; subject?: string; body?: string };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [k: string]: any;
      }>;
    }
    const { data: workflows } = await novuFetch<{ data: NovuWorkflow[] }>('/v1/workflows');

    // 从模板内容中提取 {{payload.X}} 变量名（含嵌套路径如 payload.sale_amount）
    const payloadVarRe = /\{\{\s*(?:payload\.|[\w.]*\.payload\.)([\w]+)\s*\}\}/g;
    const templateVars = new Set<string>();
    for (const wf of workflows ?? []) {
      // 从 triggers[].variables 提取
      for (const t of wf.triggers ?? []) {
        for (const v of t.variables ?? []) {
          templateVars.add(v.name);
        }
      }
      // 从 step 模板内容中正则提取 {{payload.X}}
      for (const step of wf.steps ?? []) {
        const content = [step.template?.content, step.template?.subject, step.template?.body]
          .filter(Boolean).join('\n');
        let m: RegExpExecArray | null;
        while ((m = payloadVarRe.exec(content)) !== null) {
          templateVars.add(m[1]);
        }
        payloadVarRe.lastIndex = 0; // 重置全局正则状态
      }
    }

    if (templateVars.size === 0) {
      return { name, pass: true, detail: `Novu 工作流 ${workflows?.length ?? 0} 个，无 payload 变量引用` };
    }

    // 查询 push_variables 中 enabled=true 的 var_code
    const enabledVars = await pgQuery<Array<{ var_code: string }>>(
      '/push_variables?enabled=eq.true&select=var_code',
    );
    const enabledSet = new Set(enabledVars.map((v) => v.var_code));

    const missing = [...templateVars].filter((v) => !enabledSet.has(v));
    const pass = missing.length === 0;
    return {
      name,
      pass,
      detail: pass
        ? `Novu 模板变量 ${templateVars.size} 个全部在 push_variables.enabled 中`
        : `Novu 模板引用但 push_variables.enabled 中缺失: ${missing.join(', ')}`,
      extra: { templateVars: [...templateVars], missing },
    };
  } catch (e: unknown) {
    return { name, pass: false, detail: `Novu API 查询失败: ${(e as Error).message}` };
  }
}

// ── Check 2: selector 引用存在性 ───────────────────────
async function checkSelectorRefs(): Promise<ContractCheckResult> {
  const name = 'selector_existence';
  try {
    // 从 push_trigger_logs 最近 7 天的 selector 字段提取 dept/role 引用
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const logs = await pgQuery<Array<{ selector: { kind: string; ids?: string[] } }>>(
      `/push_trigger_logs?created_at=gte.${sevenDaysAgo}&select=selector`,
    );

    const deptIds = new Set<string>();
    const roleCodes = new Set<string>();
    for (const log of logs ?? []) {
      const sel = log.selector;
      if (!sel) continue;
      if (sel.kind === 'dept' && sel.ids) sel.ids.forEach((id) => deptIds.add(id));
      if (sel.kind === 'role' && sel.ids) sel.ids.forEach((id) => roleCodes.add(id));
    }

    if (deptIds.size === 0 && roleCodes.size === 0) {
      return { name, pass: true, detail: '近 7 天无 push_trigger_logs selector 引用，跳过' };
    }

    const issues: string[] = [];

    // B7（review 修复）：入 in.() 的值来自 DB 落库的 selector.ids（起源于操作者输入/引擎推导），
    // 不做白名单校验直接拼 URL 会有 PostgREST filter 注入面（值里带 )|& 等改变查询语义）。
    // 双重防护：① 白名单字符集校验，非法值进 issues（contract 红），不进查询；
    //           ② 合法值仍 URL 编码后再拼 in.() 列表。
    const ID_RE = /^[A-Za-z0-9_-]+$/;
    const buildInList = (values: string[]): string =>
      values.map((v) => encodeURIComponent(v)).join(',');

    // 校验 dept IDs 存在于 org_departments
    if (deptIds.size > 0) {
      const deptList = [...deptIds];
      const invalidDepts = deptList.filter((id) => !ID_RE.test(id));
      for (const bad of invalidDepts) issues.push(`dept id 非法字符(仅 [A-Za-z0-9_-]): ${bad}`);
      const safeDepts = deptList.filter((id) => ID_RE.test(id));
      if (safeDepts.length > 0) {
        const existing = await pgQuery<Array<{ id: string }>>(
          `/org_departments?id=in.(${buildInList(safeDepts)})&select=id`,
        );
        const existingSet = new Set(existing.map((d) => d.id));
        const missingDepts = safeDepts.filter((id) => !existingSet.has(id));
        if (missingDepts.length > 0) {
          issues.push(`dept 缺失: ${missingDepts.join(', ')}`);
        }
      }
    }

    // 校验 role codes 存在于 roles（含 admin 常量——admin 非 roles 表行，是 env 常量，单独放行）
    const ADMIN_CODE = 'admin';
    if (roleCodes.size > 0) {
      const nonAdminCodes = [...roleCodes].filter((c) => c !== ADMIN_CODE);
      const invalidCodes = nonAdminCodes.filter((c) => !ID_RE.test(c));
      for (const bad of invalidCodes) issues.push(`role code 非法字符(仅 [A-Za-z0-9_-]): ${bad}`);
      const safeCodes = nonAdminCodes.filter((c) => ID_RE.test(c));
      if (safeCodes.length > 0) {
        const existing = await pgQuery<Array<{ code: string }>>(
          `/roles?code=in.(${buildInList(safeCodes)})&select=code`,
        );
        const existingSet = new Set(existing.map((r) => r.code));
        const missingRoles = safeCodes.filter((c) => !existingSet.has(c));
        if (missingRoles.length > 0) {
          issues.push(`role 缺失: ${missingRoles.join(', ')}`);
        }
      }
    }

    const pass = issues.length === 0;
    return {
      name,
      pass,
      detail: pass
        ? `selector 引用全部存在（dept=${deptIds.size}, role=${roleCodes.size}）`
        : issues.join('; '),
      extra: { deptIds: [...deptIds], roleCodes: [...roleCodes], issues },
    };
  } catch (e: unknown) {
    return { name, pass: false, detail: `selector 校验失败: ${(e as Error).message}` };
  }
}

// ── Check 3: role_codes 双向 diff ──────────────────────
async function checkRoleCodesBidirectional(): Promise<ContractCheckResult> {
  const name = 'role_codes_bidirectional';
  try {
    // roles 表全量 code（is_active=true）
    const roleRows = await pgQuery<Array<{ code: string }>>('/roles?is_active=eq.true&select=code');
    const rolesSet = new Set(roleRows.map((r) => r.code));

    // org_users.role_codes（is_active=true 用户，数组聚合去重）
    const userRoles = await pgQuery<Array<{ role_codes: string[] }>>(
      '/org_users?is_active=eq.true&select=role_codes',
    );
    const mirrorSet = new Set<string>();
    for (const u of userRoles ?? []) {
      (u.role_codes ?? []).forEach((c) => mirrorSet.add(c));
    }

    // admin 常量：env BREAKGLASS_ADMINS / 已知 admin code 不在 roles 表中，
    // 但可能出现在 role_codes 镜像中——双向 diff 排除 admin 常量
    const ADMIN_CODE = 'admin';

    // diff1: roles 表有，但无人在 org_users.role_codes 中使用（可能是孤儿角色）
    const rolesOnly = [...rolesSet].filter((c) => !mirrorSet.has(c) && c !== ADMIN_CODE);
    // diff2: org_users.role_codes 有，但 roles 表无（可能 Casdoor 新角色未同步）
    const mirrorOnly = [...mirrorSet].filter((c) => !rolesSet.has(c) && c !== ADMIN_CODE);

    const pass = rolesOnly.length === 0 && mirrorOnly.length === 0;
    const parts: string[] = [];
    if (rolesOnly.length > 0) parts.push(`roles 表有但镜像无: ${rolesOnly.join(', ')}`);
    if (mirrorOnly.length > 0) parts.push(`镜像有但 roles 表无: ${mirrorOnly.join(', ')}`);

    return {
      name,
      pass,
      detail: pass
        ? `角色码双向一致（roles=${rolesSet.size}, mirror=${mirrorSet.size}）`
        : parts.join('; '),
      extra: { rolesSet: [...rolesSet], mirrorSet: [...mirrorSet], rolesOnly, mirrorOnly },
    };
  } catch (e: unknown) {
    return { name, pass: false, detail: `角色码双向校验失败: ${(e as Error).message}` };
  }
}

// ── Check 4: 时区断言 ─────────────────────────────────
async function checkNovuTimezone(): Promise<ContractCheckResult> {
  const name = 'novu_timezone';
  if (!NOVU_API_URL || !NOVU_API_KEY) {
    return { name, pass: true, detail: 'Novu 未配置（NOVU_API_URL/NOVU_API_KEY 为空），跳过' };
  }
  try {
    // Novu v1: GET /v1/workflows 返回 workflow 元数据，含 preference/timezone 设置。
    // 实际 timezone 存在于 organization 设置或 workflow 级别。
    // 先查 organization 设置：GET /v1/organizations/me
    interface NovuOrg {
      data?: { timezone?: string; [k: string]: unknown };
    }
    const org = await novuFetch<NovuOrg>('/v1/organizations/me');
    const tz = org?.data?.timezone ?? '';
    const pass = tz === 'Asia/Shanghai';
    return {
      name,
      pass,
      detail: pass
        ? `Novu org timezone = Asia/Shanghai`
        : `Novu org timezone = "${tz}"（期望 Asia/Shanghai）`,
      extra: { timezone: tz },
    };
  } catch (e: unknown) {
    return { name, pass: false, detail: `Novu 时区校验失败: ${(e as Error).message}` };
  }
}

// ── 主入口 ─────────────────────────────────────────────
export const pushContractManifest: JobManifest = {
  id: JOB_KEY,
  schedule: '7 4 * * *', // 每日 04:07 Asia/Shanghai（server cron 注册时 tz 参数）
  run: async (): Promise<JobResult> => {
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
    try {
      console.log(`[scheduler] ⏰ 推送契约测试触发`);

      const results = await Promise.all([
        checkNovuTemplateVars(),
        checkSelectorRefs(),
        checkRoleCodesBidirectional(),
        checkNovuTimezone(),
      ]);

      const failed = results.filter((r) => !r.pass);
      const passed = results.filter((r) => r.pass);

      // 日志
      for (const r of results) {
        console.log(`[push-contract] ${r.pass ? '✅' : '❌'} ${r.name}: ${r.detail}`);
      }

      // 红→collect_fail 告警（企微通知）
      if (failed.length > 0) {
        const alertBody = failed
          .map((f) => `- **${f.name}**: ${f.detail}`)
          .join('\n');
        await notifyWecom(
          '⚠️ 推送契约测试失败',
          `**日期**: ${new Date().toISOString().slice(0, 10)}\n` +
          `**失败 ${failed.length}/${results.length} 项**\n${alertBody}`,
        ).catch((e: unknown) => {
          console.error('[push-contract] 告警发送失败:', (e as Error).message);
        });
      }

      return {
        status: failed.length > 0 ? 'error' : 'ok',
        message: failed.length > 0
          ? `推送契约 ${failed.length}/${results.length} 项失败: ${failed.map((f) => f.name).join(', ')}`
          : `推送契约 ${passed.length}/${results.length} 项全通过`,
        detail: results,
      };
    } catch (e: unknown) {
      console.error('[scheduler] push_contract 异常:', (e as Error).message);
      await notifyWecom(
        '⚠️ 推送契约测试异常',
        `**错误**: ${(e as Error).message}`,
      ).catch(() => {});
      return { status: 'error', message: (e as Error).message };
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  },
};
