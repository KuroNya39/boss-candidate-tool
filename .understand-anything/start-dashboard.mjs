// Start the understand-anything dashboard with proper env vars
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(
  "C:/Users/lixins/.claude/plugins/cache/Understand-Anything/understand-anything/2.7.5/packages/dashboard"
);
const projectRoot = path.resolve("E:/00lixins/web-access-main");

const proc = spawn(
  "npx",
  ["vite", "--port", "4399"],
  {
    cwd: dashboardDir,
    env: {
      ...process.env,
      GRAPH_DIR: projectRoot,
      UNDERSTAND_ACCESS_TOKEN: "my-token-123",
    },
    stdio: "inherit",
    shell: true,
  }
);

proc.on("exit", (code) => {
  console.log(`Dashboard process exited with code ${code}`);
});

console.log(`Starting dashboard...`);
console.log(`Project: ${projectRoot}`);
console.log(`Dashboard: ${dashboardDir}`);
console.log(`URL: http://localhost:4399/?token=my-token-123`);
