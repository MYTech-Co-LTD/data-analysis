// web/lib/contracts/index.ts
// ★ 单源契约包 barrel（P1-P4 web 运行时类型的家：job / collector / board）。
//  - P0 只建骨架：job-types 占位草案（P1 冻结）；collector-types（P2）/ board-types（P4）后续追加。
//  - qa-* 不放此——留 generator 语义层（services/semantic-generator/src 为单一真相源，
//    web/lib/qa 保存字节同步副本，由 web/lib/qa/__tests__/config-sync.test.ts 守一致）。
export * from './job-types';
