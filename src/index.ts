export { connect, type DbAdapter } from "./adapters/index.js";
export type { Column, ForeignKey, JsonValue, Row, TableInfo, TableRef } from "./core/types.js";
export { packWorkbook } from "./export/workbook.js";
export {
  collectPack,
  DEFAULT_MAX_ROWS,
  isDetail,
  type FollowedLink,
  type Link,
  type Pack,
  type PackOptions,
  type PackTable,
  type UnfollowedLink,
} from "./pack/collect.js";
