import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = process.cwd();
const lockPath = path.join(projectRoot, ".next-dev.lock");
const devDistDir = path.join(projectRoot, ".next-dev");

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupLock() {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Ignore lock cleanup failures.
  }
}

if (fs.existsSync(lockPath)) {
  try {
    const lockText = fs.readFileSync(lockPath, "utf8");
    const lock = JSON.parse(lockText);
    const existingPid = Number(lock?.pid);

    if (isPidRunning(existingPid)) {
      console.error(
        `[dev-stable] Another dev server is already running (PID ${existingPid}). Stop it before starting a new one.`,
      );
      process.exit(1);
    }

    cleanupLock();
  } catch {
    cleanupLock();
  }
}

fs.writeFileSync(
  lockPath,
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  "utf8",
);

try {
  fs.rmSync(devDistDir, { recursive: true, force: true });
  console.log("[dev-stable] Cleared .next-dev cache");
} catch (error) {
  console.warn("[dev-stable] Could not clear .next-dev cache:", error);
}

const child = spawn(
  process.execPath,
  ["./node_modules/next/dist/bin/next", "dev"],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "development",
    },
  },
);

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  cleanupLock();

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
