// functions/wecom-sync-contacts/index.js
// 企微通讯录同步：获取部门列表 + 用户列表，upsert 到数据库。
// 定时执行（每日）或手动触发。
// 所需 secrets：WECOM_CORP_ID / WECOM_OPS_SECRET / ANON_KEY（App B 全员可见，同步全量）
// 注意：InsForge OSS runtime 用 CommonJS + 全局注入（createClient、Deno）。

module.exports = async function (req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  function json(data, status) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const corpId = Deno.env.get("WECOM_CORP_ID");
  const corpSecret = Deno.env.get("WECOM_OPS_SECRET");

  if (!corpId || !corpSecret) {
    return json({ error: "WECOM_CORP_ID/WECOM_OPS_SECRET secrets not set" }, 500);
  }

  try {
    // 1. 获取企微 access_token
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }

    // 2. 获取部门列表
    const deptRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${accessToken}`
    );
    const deptData = await deptRes.json();
    if (deptData.errcode !== 0) {
      return json({ error: "failed_to_get_departments", detail: deptData }, 502);
    }
    const departments = deptData.department || [];

    // 3. 获取用户列表（遍历每个部门）
    const users = [];
    for (const dept of departments) {
      const userRes = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${accessToken}&department_id=${dept.id}`
      );
      const userData = await userRes.json();
      if (userData.errcode === 0 && userData.userlist) {
        users.push(...userData.userlist);
      }
    }

    // 4. 使用 ANON_KEY 连接数据库
    // 注意：INSFORGE_API_BASE 是容器内地址（deno -> insforge），INSFORGE_BASE_URL 是外部地址
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: Deno.env.get("ANON_KEY"),
    });

    // 5.1 同步部门
    if (departments.length > 0) {
      const deptRows = departments.map((d) => ({
        id: String(d.id),
        name: d.name,
        parent_id: d.parentid ? String(d.parentid) : null,
        order_weight: d.order || 0,
        is_active: true,
        synced_at: new Date().toISOString(),
      }));
      const { error: deptError } = await client.database
        .from("org_departments")
        .upsert(deptRows, { onConflict: "id" });
      if (deptError) {
        return json({ error: "upsert_departments_failed", detail: deptError }, 502);
      }
    }

    // 5.2 同步用户（去重）
    const seen = new Set();
    const userRows = [];
    for (const u of users) {
      if (seen.has(u.userid)) continue;
      seen.add(u.userid);
      userRows.push({
        wecom_id: u.userid,
        name: u.name,
        department_ids: u.department ? u.department.map(String) : [],
        position: u.position || null,
        mobile: u.mobile || null,
        email: u.email || null,
        avatar: u.avatar || null,
        is_active: true,
        synced_at: new Date().toISOString(),
      });
    }
    if (userRows.length > 0) {
      const { error: userError } = await client.database
        .from("org_users")
        .upsert(userRows, { onConflict: "wecom_id" });
      if (userError) {
        return json({ error: "upsert_users_failed", detail: userError }, 502);
      }
    }

    // 5.3 (已删 2026-08-18) role_id 自动赋值（refresh_role_assignments）——薄同步收缩后
    //     角色归属全量 manual（Casdoor UI 单写者），不再由通讯录同步推导角色。role_id 列保留
    //     为过渡列（§6.2 sunset），由登录/薄同步/drift 写穿的 role_codes 镜像取代。

    // 6. 离职对齐：企微没有但库里 is_active=true 的 → 标离职（纠正回调漏的离职）
    //    守卫：仅当本次同步到数据才对齐——防 API 异常空返回（errcode=0 但 department=[]）
    //    致 syncedUserIds 空集、把全表 is_active=true 用户误标离职（灾难性数据破坏）
    if (userRows.length > 0) {
      const syncedUserIds = new Set(userRows.map((r) => r.wecom_id));
      const { data: activeUsers, error: activeErr } = await client.database
        .from("org_users")
        .select("wecom_id")
        .eq("is_active", true);
      if (!activeErr && activeUsers) {
        const toDeactivate = activeUsers
          .map((r) => r.wecom_id)
          .filter((id) => !syncedUserIds.has(id));
        if (toDeactivate.length > 0) {
          const { error: deactErr } = await client.database
            .from("org_users")
            .update({ is_active: false })
            .in("wecom_id", toDeactivate);
          if (deactErr) console.error("[sync-contacts] deactivate users failed:", deactErr);
          else console.log(`[sync-contacts] 标记离职 ${toDeactivate.length} 人:`, toDeactivate);
        }
      }
    }

    // 部门同理（用 departments 原始数组，避开 deptRows 的 if 块作用域）
    if (departments.length > 0) {
      const syncedDeptIds = new Set(departments.map((d) => String(d.id)));
      const { data: activeDepts, error: activeDeptErr } = await client.database
        .from("org_departments")
        .select("id")
        .eq("is_active", true);
      if (!activeDeptErr && activeDepts) {
        const toDeactDept = activeDepts
          .map((r) => r.id)
          .filter((id) => !syncedDeptIds.has(id));
        if (toDeactDept.length > 0) {
          const { error: deactDeptErr } = await client.database
            .from("org_departments")
            .update({ is_active: false })
            .in("id", toDeactDept);
          if (deactDeptErr) console.error("[sync-contacts] deactivate depts failed:", deactDeptErr);
          else console.log(`[sync-contacts] 标记删除部门 ${toDeactDept.length} 个:`, toDeactDept);
        }
      }
    }

    return json({
      ok: true,
      departments: departments.length,
      users: userRows.length,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
