// web/lib/contracts/index.ts
// ★ 单源契约包 barrel（P1-P4 web 运行时类型的家：job / collector / board）。
//  - P0 建骨架：job-types 占位草案（P1 冻结）；P2 collector-types、P4 board-types 已追加。
//  - qa-* 不放此——留 generator 语义层（services/semantic-generator/src 为单一真相源，
//    web/lib/qa 保存字节同步副本，由 web/lib/qa/__tests__/config-sync.test.ts 守一致）。
export * from './job-types';
export * from './collector-types';
export * from './board-types';
