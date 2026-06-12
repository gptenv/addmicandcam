import { spawn } from "node:child_process";

const commands = [
  ["server", ["npm", ["run", "dev", "--workspace=@telepresence/server"]]],
  ["web", ["npm", ["run", "dev", "--workspace=@telepresence/web"]]]
];

let shuttingDown = false;
const children = [];

for (const [name, [command, args]] of commands) {
  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: process.platform === "win32"
  });

  child.stdout.on("data", (chunk) => process.stdout.write(prefixLines(name, chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefixLines(name, chunk)));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const other of children) {
      if (other !== child) other.kill("SIGTERM");
    }
    process.exit(code ?? (signal ? 1 : 0));
  });

  children.push(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    for (const child of children) {
      child.kill("SIGTERM");
    }
  });
}

function prefixLines(name, chunk) {
  return String(chunk)
    .split(/\n/)
    .map((line, index, lines) => {
      if (index === lines.length - 1 && line === "") return "";
      return `[${name}] ${line}`;
    })
    .join("\n");
}
