# 报表权限运维手册（2026-08-03 权限收口后）

## 模型
生效权限 = 个人 override > 角色 ∪ 部门（get_user_perms 合成，登录时写入 JWT，
用户重新登录后新权限生效）。行过滤在 report_*_gen 视图（claim_match_or_star），
列脱敏 can_see_cost CASE。claim 缺失/含 "*" = 放行。

## 常见操作（生产 psql：docker exec deploy-postgres-1 psql -U postgres -d insforge）

### 收窄某部门可见门店
UPDATE org_departments SET branch_nums='["3","5","8"]'::jsonb WHERE id='<企微部门id>';
-- 门店号跨账套重复，brands 维度经角色层控制；收窄后通知该部门用户重新登录。

### 放开/收回某部门成本可见
UPDATE org_departments SET can_see_cost=true WHERE id='<id>';   -- 收回置 false

### 给个人临时授权（如临时看成本 7 天）
INSERT INTO data_permissions (subject_type, subject_id, can_see_cost, expires_at, note)
VALUES ('user', '<wecom_id>', true, NOW() + INTERVAL '7 days', '临时成本核对');

### 指派/恢复角色
-- 优先用 /admin/permissions 页面；SQL 等效：
UPDATE org_users SET role_id=<roles.id>, role_source='manual' WHERE wecom_id='<id>';
UPDATE org_users SET role_id=NULL, role_source='auto' WHERE wecom_id='<id>';  -- 恢复自动

### 排障：看某人当前生效权限
SELECT get_user_perms('<wecom_id>');
