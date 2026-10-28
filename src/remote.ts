import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { Core } from "./core.js";
import { PORT, TOKEN_FILE } from "./server.js";

// node:http rather than fetch: fetch gives up on an answer slower than five minutes (undici's headers timeout), and a
// call can now wait that long for its turn on Flow's page behind a running job (PageLock in queue.ts).
function post(method: string, args: unknown): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(args ?? {});
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: `/api/${method}`,
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-flow-token": readFileSync(TOKEN_FILE, "utf8").trim() },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        res.on("error", fail);
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

// Used when another flow-mcp process (Studio or a second Claude client) already owns the Flow tab and queue.
async function call(method: string, args: unknown): Promise<unknown> {
  const res = await post(method, args).catch((err: Error & { code?: string }) => {
    // The owner is decided once, at start-up: when that process ends (its app session closed), this one cannot take over.
    throw new Error(
      `The flow-mcp process that owned the Flow tab has stopped (${err.code ?? err.message}). Restart this app's flow MCP server, or keep Flow Studio running (npm run studio) as the owner.`,
    );
  });
  const data = JSON.parse(res.body) as { error?: string };
  if (res.status < 200 || res.status >= 300) throw new Error(data.error ?? `flow-mcp owner process answered ${res.status}`);
  return data;
}

export class RemoteCore implements Core {
  status = (a: unknown) => call("status", a);
  generate = (a: unknown) => call("generate", a);
  cancel = (a: unknown) => call("cancel", a);
  retry = (a: unknown) => call("retry", a);
  assets = (a: unknown) => call("assets", a);
  download = (a: unknown) => call("download", a);
  assemble = (a: unknown) => call("assemble", a);
  techniques = (a: unknown) => call("techniques", a);
  voices = () => call("voices", {});
  narrate = (a: unknown) => call("narrate", a);
  character = (a: unknown) => call("character", a);
  characters = () => call("characters", {});
  character_edit = (a: unknown) => call("character_edit", a);
  edit = (a: unknown) => call("edit", a);
  trash = (a: unknown) => call("trash", a);
  open_project = (a: unknown) => call("open_project", a);
  discard = (a: unknown) => call("discard", a);
  set_key = (a: unknown) => call("set_key", a);
  continue_shot = (a: unknown) => call("continue_shot", a);
  agent = (a: unknown) => call("agent", a);
  outputs = () => call("outputs", {});

  // Long waits are split up, so no single request is held open for long.
  async wait(a: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
    const deadline = Date.now() + a.timeout_seconds * 1000;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const out = (await call("wait", { ...a, timeout_seconds: Math.max(5, Math.min(120, left)) })) as { finished: boolean };
      if (out.finished || left <= 120) return out;
    }
  }
}
