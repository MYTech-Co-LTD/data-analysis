-- 企微部门组→门店映射重灌（2026-08-17，用户裁定：组织架构严格按企微）
-- 规则：战区/区部门名精确匹配 dim_branch 区域字段 → 辖区门店多行；
--       非战区链部门（职能部门等 30 个）→ 全店 388 行（用户裁定：职能部门=全店）。
-- 形态：group_type='dept'、group_id=部门名、branch_number=门店全局键；旧 store/region 行全删。
BEGIN;

DELETE FROM maps_branch_group;

-- 战区部门（4）：first_level_region = 部门名
INSERT INTO maps_branch_group (group_id, group_name, group_type, branch_number, is_active)
SELECT d.name, d.name, 'dept', b.branch_number, true
FROM org_departments d
JOIN dim_branch b ON b.first_level_region = d.name
WHERE d.is_active AND b.is_active AND b.branch_number IS NOT NULL
  AND d.name IN ('东部战区','西部战区','中部战区','南部战区');

-- 区部门（14）：second_level_region = 部门名
INSERT INTO maps_branch_group (group_id, group_name, group_type, branch_number, is_active)
SELECT d.name, d.name, 'dept', b.branch_number, true
FROM org_departments d
JOIN dim_branch b ON b.second_level_region = d.name
WHERE d.is_active AND b.is_active AND b.branch_number IS NOT NULL
  AND d.name IN ('东部一区','东部二区','东部三区','东部四区',
                 '西部一区','西部二区',
                 '中部一区','中部二区','中部三区',
                 '南部一区','南部二区','南部三区','南部四区','南部五区');

-- 非战区链部门（30，含根/职能/待设置）：全店 388
INSERT INTO maps_branch_group (group_id, group_name, group_type, branch_number, is_active)
SELECT d.name, d.name, 'dept', b.branch_number, true
FROM org_departments d
CROSS JOIN (SELECT DISTINCT branch_number FROM dim_branch WHERE is_active AND branch_number IS NOT NULL) b
WHERE d.is_active
  AND d.name NOT IN ('东部战区','西部战区','中部战区','南部战区',
                     '东部一区','东部二区','东部三区','东部四区',
                     '西部一区','西部二区',
                     '中部一区','中部二区','中部三区',
                     '南部一区','南部二区','南部三区','南部四区','南部五区');

-- 对账输出：每部门映射门店数（战区应=其辖区总数，职能应=388）
SELECT group_id, count(*) AS stores,
       count(*) FILTER (WHERE branch_number LIKE '3120-%') AS xiongmao,
       count(*) FILTER (WHERE branch_number LIKE '64188-%') AS pinpintian
FROM maps_branch_group GROUP BY group_id ORDER BY stores DESC, group_id;

-- 死信清理（provision 已由迁移脚本直接完成，outbox 全部为 DEAD_LETTER 残留）
DELETE FROM sync_outbox;

COMMIT;
