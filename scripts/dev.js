import { spawn } from "node:child_process";
import net from "node:net";

const API_START_PORT = Number(process.env.PORT || 4177);
const CLIENT_PORT = Number(process.env.CLIENT_PORT || 5173);
let shuttingDown = false;
const children = [];

function spawnProcess({ label, command, args, env }) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    },
    stdio: "inherit",
    shell: false
  });

  child.on("exit", (code) => {
    if (code !== 0) {
      console.error(`${label} exited with code ${code}`);
    }
    shutdown();
  });

  children.push(child);
  return child;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    server.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });

    server.once("listening", () => {
      server.close(() => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
    });

    server.listen({
      port,
      host: "::"
    });
  });
}

async function findAvailablePort(startPort) {
  let currentPort = startPort;

  while (!(await isPortAvailable(currentPort))) {
    currentPort += 1;
  }

  return currentPort;
}

function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function start() {
  const apiPort = await findAvailablePort(API_START_PORT);

  console.log(`Using API port ${apiPort} and client port ${CLIENT_PORT}`);

  spawnProcess({
    label: "server",
    command: "node",
    args: ["server/index.js"],
    env: {
      PORT: String(apiPort)
    }
  });

  spawnProcess({
    label: "client",
    command: "node",
    args: ["./node_modules/vite/bin/vite.js"],
    env: {
      VITE_API_PORT: String(apiPort),
      PORT: String(CLIENT_PORT)
    }
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
