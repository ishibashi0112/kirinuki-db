import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/cli/bin.ts" },
  format: ["esm"],
  target: "node22",
  // keep "node:sqlite" intact: it has no bare-specifier alias
  removeNodeProtocol: false,
  external: ["mssql", "oracledb", "pg"],
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
});
