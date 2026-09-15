import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** @param {string} directory */
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) check(path);
    else if (path.endsWith(".mjs")) {
      const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const directory of ["src", "planner", "tests", "scripts"]) check(directory);
