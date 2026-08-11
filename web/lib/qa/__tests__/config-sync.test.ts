// web/lib/qa/__tests__/config-sync.test.ts
// 防漂移：web 运行时导入 web/lib/qa/config/ 的配置副本（Next.js 生产构建无法打包根目录外的
// ../../services/...，故 web 侧必须有自包含副本），语义层 src/ 仍为配置单一真相源。
// 本测试断言两处字节一致——改动配置必须同步两处，否则 CI 红。
// qa-types.ts 同理：web 侧共享类型副本为 web/lib/qa/types-shared.ts（web/lib/qa/types.ts re-export），
// 必须与语义层 qa-types.ts 字节一致。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
// web/lib/qa/__tests__/ -> 上 4 级 = 仓库根
const originals = {
  'detail-sources.json': `${repoRoot}/services/semantic-generator/src/detail-sources.json`,
  'qa-checks.json': `${repoRoot}/services/semantic-generator/src/qa-checks.json`,
  'qa-types.ts': `${repoRoot}/services/semantic-generator/src/qa-types.ts`,
};

const webCopyDir = fileURLToPath(new URL('../config/', import.meta.url));
const webSharedTypesPath = fileURLToPath(new URL('../types-shared.ts', import.meta.url));

describe('qa 配置副本与语义层真相源一致', () => {
  for (const [name, originalPath] of Object.entries(originals)) {
    it(`${name} 两处字节一致`, () => {
      const orig = readFileSync(originalPath, 'utf8');
      const copy = readFileSync(name === 'qa-types.ts' ? webSharedTypesPath : `${webCopyDir}${name}`, 'utf8');
      expect(copy).toBe(orig);
    });
  }
});
