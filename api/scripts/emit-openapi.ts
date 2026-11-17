import { createApp } from "../src/app";
import { createContainer } from "../src/container";

const app = createApp(createContainer());
const res = await app.request("/openapi.json");
await Bun.write("openapi.json", `${JSON.stringify(await res.json(), null, 2)}\n`);
process.stdout.write("wrote openapi.json\n");
