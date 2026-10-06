/**
 * Constructs the MCODE web worker — without hardcoding any origin, so the same
 * code works wherever the app is served from. Shared by `useMcodeWorker` (the
 * panel's analysis) and `clusterLayoutWorker` (the layout algorithm), which
 * runs outside React.
 *
 * PRODUCTION: `?worker&inline` embeds the bundled worker (its import graph is
 * pure algorithm code) into this chunk and constructs it from a Blob at
 * runtime. A Blob worker is same-origin by construction, so it works no matter
 * where the remote is deployed — any origin, any base path, no CORS, no URL to
 * resolve. (The alternative, `?worker&url`, emits a root-absolute `/assets/…`
 * URL because the SDK owns `base: '/'`, which breaks subpath deployments.)
 *
 * DEV: Vite serves modules unbundled, so there is nothing to inline — the
 * inline wrapper falls back to `new Worker(<dev url>)`, and that breaks
 * cross-origin: this app is a Module Federation remote whose modules are
 * served from its own dev server (e.g. :6600) while the page is the host's
 * origin (e.g. cyweb on :5500), and browsers forbid constructing a Worker
 * directly from a cross-origin script URL. So in dev we build the worker from
 * a tiny same-origin Blob module that `import`s the dev-served worker module —
 * a module import may cross origins under CORS, and the dev server already
 * sends `Access-Control-Allow-Origin: *` (the host needs it to import
 * remoteEntry.js at all).
 */
import McodeWorkerInline from './mcode.worker?worker&inline'

/**
 * Path of the worker module, for DEV only. Kept in a variable (not written
 * literally inside `new URL(...)`) so Vite's asset transform does not match the
 * pattern at build time and emit the raw .ts file as an asset; the whole dev
 * branch is dead code in a production build anyway.
 */
const DEV_WORKER_PATH = './mcode.worker.ts'

export function createMcodeWorker(name = 'mcode-worker'): Worker {
  if (import.meta.env.PROD) {
    return new McodeWorkerInline({ name })
  }

  const workerUrl = new URL(DEV_WORKER_PATH, import.meta.url).href
  // Log the resolved URL so it can be checked directly (browser Network tab /
  // curl) when diagnosing load failures.
  console.debug(`Creating MCODE worker from: ${workerUrl}`)

  // The revoke frees the Blob once the module graph has loaded (static imports
  // resolve before the module body runs) — the same trick Vite's own inline
  // worker wrapper uses.
  const bootstrap =
    `import ${JSON.stringify(workerUrl)};\n` + `URL.revokeObjectURL(import.meta.url);`
  const blobUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }))
  const worker = new Worker(blobUrl, { type: 'module', name })
  // A failed import of the (cross-origin) worker script surfaces here as an
  // often-opaque error event. Echo the URL and a hint, since the event
  // message is usually empty for cross-origin worker load failures. (The
  // caller's onerror handler is what actually rejects the pending work.)
  worker.addEventListener('error', (event) => {
    console.error(
      `MCODE worker failed to load from "${workerUrl}". ` +
        'Check that the dev server serves this exact URL (HTTP 200) — a stale ' +
        'dev server usually needs a full restart, not just HMR. ' +
        `Worker error: ${event.message || '(no message; likely a cross-origin load failure)'}`,
    )
  })
  return worker
}
