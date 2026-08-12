import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const target = process.argv[2] ?? "all";
const lockPath = path.join(projectRoot, ".next-dev.lock");

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

function shouldCleanDevArtifacts() {
  return target === "all" || target === "dev";
}

function shouldCleanBuildArtifacts() {
  return target === "all" || target === "build";
}

if (shouldCleanDevArtifacts() && fs.existsSync(lockPath)) {
  try {
    const lockText = fs.readFileSync(lockPath, "utf8");
    const lock = JSON.parse(lockText);
    const existingPid = Number(lock?.pid);

    if (isPidRunning(existingPid)) {
      console.error(
        `[clean-next] Refusing to clean dev cache while dev server is running (PID ${existingPid}). Stop dev first.`,
      );
      process.exit(1);
    }

    fs.rmSync(lockPath, { force: true });
  } catch {
    fs.rmSync(lockPath, { force: true });
  }
}

const dirsToClean = [];
if (shouldCleanDevArtifacts()) {
  dirsToClean.push(path.join(projectRoot, ".next-dev"));
  dirsToClean.push(path.join(projectRoot, ".next"));
}

if (shouldCleanBuildArtifacts()) {
  dirsToClean.push(path.join(projectRoot, ".next"));
}

try {
  for (const dir of dirsToClean) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[clean-next] Cleared ${path.basename(dir)} cache`);
  }
} catch (error) {
  console.warn("[clean-next] Could not clean cache:", error);
}
