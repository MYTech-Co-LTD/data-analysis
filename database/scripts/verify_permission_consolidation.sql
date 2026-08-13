-- verify_permission_consolidation.sql —— 逐维合成行为验证（migrate 167 后跑；幂等；末尾 ROLLBACK 不留痕）
-- 与 plan Task 1 Step 2 一致，三处必要修正（断言语义不变）：
--   1) org_users.department_ids 是 JSONB 列 → 字面量用 '["vp_*"]'::jsonb（plan 的 ARRAY[...] 是 text[]，无法隐式转 jsonb）；
--   2) 李四不配 role（role_id=NULL）：plan 断言其门店=[2,3] 纯由部门 d2 并集贡献——
--      若给 vp_role_a（branch_nums=["*"]），基底并集含 "*" 会收敛为 ["*"]，与断言矛盾；
--   3) 数组断言改 jsonb 相等（p->'f' = '[...]'::jsonb）：jsonb 文本输出带空格（["2", "3"]），
--      用 p->>'f' 与 '["2","3"]' 做字符串比较必不等；消息表达式括号包裹 p->>'f'——
--      PG 中 || 与 ->> 同优先级左结合，'a'||p->>'f' 会被解析为 ('a'||p)->>'f' 而把 'a' 当 jsonb 解析报错。
BEGIN;
-- 清场（幂等）：删除验证期间创建但未回滚的残留
DELETE FROM data_permissions WHERE note LIKE '[verify]%';
DELETE FROM org_users WHERE wecom_id IN ('vp_zhang','vp_wang','vp_li','vp_zhao');
DELETE FROM org_departments WHERE id IN ('vp_d1','vp_d2');
DELETE FROM roles WHERE code IN ('vp_role_a','vp_role_b');

-- 环境：1 角色（全门店+水果+不可见成本）+ 2 部门（d1=门店1,2+成本false；d2=门店2,3+成本true）
INSERT INTO roles (code,name,default_landing,visible_panels) VALUES ('vp_role_a','verifyA','/','[]');
INSERT INTO org_departments (id,name,is_active) VALUES ('vp_d1','verifyD1',true),('vp_d2','verifyD2',true);
INSERT INTO data_permissions (subject_type,subject_id,branch_nums,brands,categories,can_see_cost,note)
SELECT 'role', id::text, '["*"]','["*"]','["水果"]',false,'[verify]角色默认' FROM roles WHERE code='vp_role_a';
INSERT INTO data_permissions (subject_type,subject_id,branch_nums,brands,categories,can_see_cost,note)
VALUES ('dept','vp_d1','["1","2"]',NULL,NULL,false,'[verify]部门1'),
       ('dept','vp_d2','["2","3"]',NULL,NULL,true,'[verify]部门2');
-- 用户（department_ids 关联部门；李四无角色 → 纯部门基底，验并集 [2,3]）
INSERT INTO org_users (wecom_id,name,department_ids,is_active,role_id)
VALUES ('vp_zhang','张三','["vp_d1","vp_d2"]'::jsonb,true,(SELECT id FROM roles WHERE code='vp_role_a')),
       ('vp_wang','王五','["vp_d1"]'::jsonb,true,(SELECT id FROM roles WHERE code='vp_role_a')),
       ('vp_li','李四','["vp_d2"]'::jsonb,true,NULL),
       ('vp_zhao','赵六','["vp_d1"]'::jsonb,true,(SELECT id FROM roles WHERE code='vp_role_a'));
-- 个人 override：王五「只填门店 ['9'] + 成本 true」→ 应覆盖门店/成本，品牌/品类继承
INSERT INTO data_permissions (subject_type,subject_id,branch_nums,can_see_cost,note)
VALUES ('user','vp_wang','["9"]',true,'[verify]个人覆盖门店+成本');

-- 断言
DO $$
DECLARE p jsonb;
BEGIN
  -- 张三：无 override → 基底并集。门店=角色*∪d1∪d2 → ["*"]收敛；品类=角色["水果"]；成本=role false OR d1 false OR d2 true=true
  p := get_user_perms('vp_zhang');
  ASSERT p->'branch_nums' = '["*"]'::jsonb, '张三门店应[*]: '||(p->>'branch_nums');
  ASSERT p->'categories' = '["水果"]'::jsonb, '张三品类应[水果]: '||(p->>'categories');
  ASSERT (p->>'can_see_cost')::boolean = true, '张三成本应 true(部门d2): '||(p->>'can_see_cost');

  -- 王五：override 配了门店+成本 → 覆盖；品类继承角色
  p := get_user_perms('vp_wang');
  ASSERT p->'branch_nums' = '["9"]'::jsonb, '王五门店应[9](覆盖): '||(p->>'branch_nums');
  ASSERT p->'categories' = '["水果"]'::jsonb, '王五品类应[水果](继承): '||(p->>'categories');
  ASSERT (p->>'can_see_cost')::boolean = true, '王五成本应 true(覆盖): '||(p->>'can_see_cost');

  -- 赵六：无 override、部门 d1（cost false）→ 成本 false；门店=角色[*]∪d1 并集 → ["*"] 收敛
  p := get_user_perms('vp_zhao');
  ASSERT p->'branch_nums' = '["*"]'::jsonb, '赵六门店应[ * ](角色全放): '||(p->>'branch_nums');
  ASSERT (p->>'can_see_cost')::boolean = false, '赵六成本应 false: '||(p->>'can_see_cost');

  -- 李四（无角色，仅部门 d2 基底）验部门并集 [2,3] + 成本 true
  p := get_user_perms('vp_li');
  ASSERT p->'branch_nums' = '["2","3"]'::jsonb, '李四门店应[2,3](d2): '||(p->>'branch_nums');
  ASSERT (p->>'can_see_cost')::boolean = true, '李四成本应 true(d2): '||(p->>'can_see_cost');

  RAISE NOTICE '✔ verify_permission_consolidation: 全部断言通过';
END $$;
ROLLBACK;
