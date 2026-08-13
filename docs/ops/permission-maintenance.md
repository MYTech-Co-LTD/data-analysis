# 报表权限运维手册（2026-08-13 权限体系重构后）

## 模型
生效权限 = 个人 override（按字段覆盖）> 角色∪部门（基底叠加）。合成在 get_user_perms，
登录时写入 JWT，用户重新登录后生效。行过滤 report_*_gen（claim_match_or_star），列脱敏 can_see_cost CASE。
权限数据统一存 data_permissions（role/dept/user 三 subject）；变更一律走 /admin/permissions 页面（自动落 permission_audit），
SQL 直改绕不过审计，禁止。部门权限两维（branch_nums + can_see_cost），品牌/品类仅角色/个人层。
门店键铁律：branch_num 跨账套重复，最终过滤永远 (brands? sbc) AND (branch_nums? n) 双重组合；
选择器按品牌分组仅为勾选便利，存储仍只写 branch_nums。

## 常见操作（全部走页面 /admin/permissions）
- 收窄某部门可见门店 → 部门 tab → 该部门 → 门店选择器勾选（去勾「全部门(*)」）
- 放开/收回部门成本 → 部门 tab → 成本开关
- 个人单独授权 / 临时授权（含到期） → 用户 tab → 单独授权
- 收回个人单独授权 → 用户 tab → 删除该 override（恢复继承）
- 调整角色默认范围/参数 → 角色 tab
- 指派 / 恢复角色 → 用户 tab（manual 不被同步覆盖）

## 排障
SELECT get_user_perms('<wecom_id>');   -- 合成结果
-- 核对迁移（167）后的权限行：
SELECT subject_type, subject_id, branch_nums, brands, categories, can_see_cost, expires_at FROM data_permissions ORDER BY subject_type, subject_id;
