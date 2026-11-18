const apps = ["api", "ws", "worker", "feed"];
const children = apps.map((app) =>
  Bun.spawn(["bun", "--watch", `src/apps/${app}.ts`], { stdout: "inherit", stderr: "inherit" }),
);
function shutdown() {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await Promise.race(children.map((child) => child.exited));
shutdown();
await Promise.all(children.map((child) => child.exited));
