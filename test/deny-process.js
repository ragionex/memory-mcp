import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = () => {
    fs.appendFileSync(process.env.RAGIONEX_TEST_PROCESS_LOG, `${name}\n`);
    throw new Error("Unexpected runtime process launch");
  };
}
syncBuiltinESMExports();
