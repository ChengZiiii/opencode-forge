import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

// Isolated, explicitly complete native session view for close fixtures.
export async function crewNativeView(root, reset) {
  const view = { rows: [], active: {} }
  const host = createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(req.url.startsWith("/api/session/active") ? view.active : { data: view.rows, cursor: {} }))
  })
  await new Promise(resolve => host.listen(0, "127.0.0.1", resolve))
  const old = process.env.FORGE_SERVICE_FILE
  process.env.FORGE_SERVICE_FILE = join(root, "crew-service.json")
  writeFileSync(process.env.FORGE_SERVICE_FILE, JSON.stringify({ url: `http://127.0.0.1:${host.address().port}`, password: "test" }))
  reset()
  return { view, async close() {
    host.closeAllConnections?.()
    await new Promise(resolve => host.close(resolve))
    if (old === undefined) delete process.env.FORGE_SERVICE_FILE; else process.env.FORGE_SERVICE_FILE = old
    reset()
  } }
}
