// web/lib/collectors/registry.ts
// 数据源采集器注册表（spec §4.2：kind → collector）。
// 宿主只依赖本注册表 + contracts——新数据源 = 新目录（collectors/<source>/）+ 此处追加 1 行。
import type { Collector } from '../contracts';
import { lemengCollector } from './lemeng';

export const COLLECTORS: Record<string, Collector> = {
  lemeng: lemengCollector,
};
