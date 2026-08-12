#!/usr/bin/env node

import { spawn } from "node:child_process";

function duration(value, label) {
  const match = String(value ?? "").trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) throw new Error(`${label} must be a duration such as 500ms, 10s, 3m, or 1h`);
  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const milliseconds = Number(match[1]) * units[(match[2] || "ms").toLowerCase()];
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) {
    throw new Error(`${label} is outside the supported range`);
  }
  return milliseconds;
}

function usage() {
  console.error("usage: run-with-timeout.mjs --timeout <duration> [--kill-after <duration>] -- command [args...]");
}

let timeoutValue = "";
let killAfterValue = "10s";
let separator = -1;
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--") { separator = index; break; }
  if (process.argv[index] === "--timeout") timeoutValue = process.argv[++index] ?? "";
  else if (process.argv[index] === "--kill-after") killAfterValue = process.argv[++index] ?? "";
}

const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
if (!timeoutValue || !command.length) {
  usage();
  process.exit(64);
}

let timeoutMs;
let killAfterMs;
try {
  timeoutMs = duration(timeoutValue, "Timeout");
  killAfterMs = duration(killAfterValue, "Kill-after timeout");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(64);
}

const detached = process.platform !== "win32";
const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: process.env,
  detached,
});

let timedOut = false;
let forceTimer;
const signalChild = (signal) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (detached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

const timeoutTimer = setTimeout(() => {
  timedOut = true;
  console.error(`Command exceeded ${timeoutValue}; terminating it.`);
  signalChild("SIGTERM");
  forceTimer = setTimeout(() => signalChild("SIGKILL"), killAfterMs);
  forceTimer.unref();
}, timeoutMs);
timeoutTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => signalChild(signal));
}

child.on("error", (error) => {
  clearTimeout(timeoutTimer);
  if (forceTimer) clearTimeout(forceTimer);
  console.error(`Could not start ${command[0]}: ${error.message}`);
  process.exitCode = 69;
});

child.on("exit", (code, signal) => {
  clearTimeout(timeoutTimer);
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) process.exitCode = 124;
  else if (typeof code === "number") process.exitCode = code;
  else {
    console.error(`Command ended after signal ${signal ?? "unknown"}.`);
    process.exitCode = 1;
  }
});
