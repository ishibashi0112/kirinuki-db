#!/usr/bin/env node
import { main } from "./main.js";

// node:sqlite prints an ExperimentalWarning on first use; it is noise for CLI users.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && w.message.includes("SQLite")) return;
  console.warn(`${w.name}: ${w.message}`);
});

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
