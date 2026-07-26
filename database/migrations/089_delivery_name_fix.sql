-- 089_delivery_name_fix.sql
-- 修 delivery name 冲突（088 漏改 name：delivery 还叫"出库金额"，和 outbound"出库金额"重名）
-- delivery = 总部→熊喵门店（配送调拨），name 改"配送-熊喵门店"以区分 distribution(配送合计) / outbound(出库)
-- 幂等：UPDATE

UPDATE metric_registry SET name = '配送-熊喵门店金额' WHERE metric_code = 'delivery_amount';
UPDATE metric_registry SET name = '配送-熊喵门店毛利' WHERE metric_code = 'delivery_profit';

DO $$ BEGIN RAISE NOTICE 'Migration 089: delivery name 改「配送-熊喵门店」(区分 distribution配送/outbound出库)'; END $$;
