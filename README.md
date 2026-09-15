# MCODE App — Cytoscape Web

As a Cytoscape Web plugin, MCODE finds clusters (highly interconnected regions) in a network.
Clusters mean different things in different types of networks.
For instance, clusters in a protein-protein interaction network are often protein complexes and parts of pathways,
while clusters in a protein similarity network represent protein families.

| Field | Value |
|---|---|
| Federation name | `mcode` (from `cyweb.id` in `package.json`) |
| Dev server port | `6600` (from `cyweb.port` in `package.json`) |
| Dev entry point | `http://localhost:6600/remoteEntry.js` |

The build is **Vite + [`@cytoscape-web/app-runtime`](https://www.npmjs.com/package/@cytoscape-web/app-runtime)**
(`defineCyWebApp` in [vite.config.ts](vite.config.ts)). The app's identity — id,
display name, dev port — lives in the `cyweb` block in `package.json` and is
read everywhere else from there (the federation container, the `CyApp` config
via `virtual:cyweb-app-meta`, and the dev install manifest).

> The dev port is 6600 rather than the docs' customary 6000 because Chrome
> refuses to fetch from port 6000 (`net::ERR_UNSAFE_PORT` — it is the X11 port).

---

## Quick start

Node 24 is enforced, not just recommended: `.nvmrc` pins it for `nvm use`,
`.npmrc` sets `engine-strict` so `npm install` refuses an older Node, and
`vite.config.ts` fails any build or dev run below 24.

```bash
# 1. Install dependencies (Node >= 24)
npm install

# 2. Start the dev server
npm run dev
```

The dev server prints the link that installs the app into a running local host
— **nothing in the host repository is edited**:

```
  Cytoscape Web app mcode — http://localhost:6600

  Install it into a local host:
  http://localhost:5500/?installApp=http%3A%2F%2Flocalhost%3A6600%2Fcyweb-app.json
```

Start the host (`npm run dev` in a
[cytoscape-web](https://github.com/cytoscape/cytoscape-web) checkout, on :5500),
open that link (or paste `http://localhost:6600/cyweb-app.json` into
**Apps → Manage Apps… → Install from URL**), confirm the install, and enable
MCODE. The manifest at `/cyweb-app.json` is generated from `package.json` on
every request, so it cannot go stale.

Changes to the app rebuild immediately, but Vite HMR does not cross the
federation boundary — reload the host page to pick them up.

## Per-network results (`appData`)

MCODE results are stored through the host's per-app storage API, one entry per
network:

| What | Call |
|---|---|
| Store one network's results | `appData.set(networkId, 'results', payload)` |
| Read them back (synchronous) | `appData.get(networkId, 'results')` |
| The result-id counter, app-scoped | `appData.setGlobal('nextResultId', n)` |

The api arrives as `context.apis.appData` in `MCODEApp.mount()` and is held in
[src/model/mcodeAppData.ts](src/model/mcodeAppData.ts), which writes on every
store change (debounced) and reads once per network. The JSON form the entries
hold is [src/model/mcodeResultPersistence.ts](src/model/mcodeResultPersistence.ts):
the algorithm's scoring snapshot with its `Map`s flattened, and cluster
thumbnails dropped (they are regenerated on demand, and one entry is capped at
5 MB).

Entries are **local by default** — they never reach a CX2 download, an NDEx
save or "Open in Cytoscape". `set(..., { export: true })` puts the entry in the
network's `cyAppData` CX2 aspect instead, which travels with the network. MCODE
keeps results local.

Two behaviors follow from this, both worth testing by hand:

1. **The panel follows the current network.** Switching network re-reads that
   network's results and moves the selection onto them, instead of leaving the
   previous network's clusters on screen.
2. **Results survive a reload.** They also survive disabling and re-enabling
   the app — `appData` is the one per-app domain the host does not clean up on
   disable. Use the panel's discard actions to drop them.

## MCODE Cluster Layout (`'layout-algorithm'` slot)

The app registers **Layout → MCODE Cluster Layout**, a TypeScript port of the
Cluster Layout from MCODE 2.1.0 for Cytoscape Desktop. Each MCODE cluster is
packed into a disk with its best-scored node in the center, unclustered nodes
are attached as satellites to the cluster they connect to most, and the disks
are placed by a short force-directed pass so connected clusters sit near each
other. The host renders it in the Layout menu's app block, in
**Layout → Settings…** with its parameters, and runs it through
`layout.applyLayout(networkId, { algorithmName: 'mcode::cluster-layout' })`.

| File | Role |
|---|---|
| [src/model/clusterLayoutModel.ts](src/model/clusterLayoutModel.ts) | The layout on plain arrays, line-for-line from `ClusterLayoutModel.java`; pure and unit-tested against the Java output |
| [src/model/clusterAssignment.ts](src/model/clusterAssignment.ts) | Node → cluster index from an MCODE result or a node column |
| [src/layout/mcodeClusterLayout.ts](src/layout/mcodeClusterLayout.ts) | The `RegisterLayoutOptions` adapter: resolves the clusters, node sizes and the previous centroid, returns positions |
| [src/model/clusterLayoutWorker.ts](src/model/clusterLayoutWorker.ts) | Runs one layout in the MCODE web worker (a fresh worker per run, terminated on reply) |
| [src/model/mcodeWorkerFactory.ts](src/model/mcodeWorkerFactory.ts) | Worker construction shared by the analysis hook and the layout |

Cluster sources, first match wins: the `clusterColumn` parameter (distinct
values of a node column), then the network's newest MCODE result, then — with
`runMCODE` on — a transient MCODE run with default parameters and fluff off
(nothing is stored, no node columns are written). With no clusters at all,
every connected component becomes a disk. The model runs in the MCODE web
worker, like the analysis, so a large network does not freeze the host; the
host has no cancel channel for layouts, so each run gets its own short-lived
worker.

The MCODE panel's Options menu has **Apply Cluster Layout**, which lays out
the selected result's source network with that result's clusters through
`layout.applyLayout` (Desktop: the panel's "Apply Cluster Layout"). The
layout's current Settings values apply; only the cluster source is pinned.

Edge bundling is not ported: Cytoscape Web has no edge-geometry visual
property to hold bends. See
[docs/cluster-layout-port-plan.md](docs/cluster-layout-port-plan.md).

### Requires a host with the `'layout-algorithm'` slot

The slot landed in [cytoscape-web#734](https://github.com/cytoscape/cytoscape-web/pull/734)
and ships in `@cytoscape-web/api-types` 1.0.0-beta.5. Until that version is
published, run the host from that branch and link its locally built types as
described below for `appData`. If `npm link` fails on the global prefix's
permissions, a plain symlink does the same job:

```bash
rm -rf node_modules/@cytoscape-web/api-types && ln -s ../../../cytoscape-web/packages/api-types node_modules/@cytoscape-web/api-types
```

### Requires a host with the `appData` API

The API landed in [cytoscape-web#687](https://github.com/cytoscape/cytoscape-web/pull/687).
Until it is on `development` and the types are published, run the host from
that branch and link its locally built types:

```bash
# in the cytoscape-web checkout, on the PR branch
npm run build:api-types
cd packages/api-types && npm link && cd -

# here
npm link @cytoscape-web/api-types
```

`npm install` in this repo drops the link; re-run the last command, or
`npm install @cytoscape-web/api-types` to go back to the published package.
Only `npm run typecheck` needs the link — the Vite build transpiles without
type checking, and `cyweb/*` modules resolve from the running host at runtime.

## Other commands

```bash
npm run build       # production build into dist/
npm run build:zip   # production build + App Store archive (see below)
npm run verify      # cyweb-app verify — asserts the federation shape of dist/
npm run typecheck   # tsc over app sources and vite.config.ts
npm test            # MCODE algorithm unit tests (Node test runner)
```

## Package for the App Store

```bash
npm run build:zip
```

writes `mcode-<version>.zip` next to `package.json` — the file the Cytoscape
App Store submission page takes. The archive contains the browser publish set
plus a generated `cy-manifest.json` (derived from this `package.json`; never
edit or commit one), and the build is verified with the same checks as
`npm run verify` before it is packaged. A plain `npm run build` does not
write the zip.

Prefer building the release zip in CI: a workstation build embeds absolute
build-machine paths in `remoteEntry.js` (harmless dead literals, but they
disclose your username and directory layout).

---

## The production bundle

`npm run build` produces the deployable **Module Federation remote** in
`dist/`. There are **no hardcoded host URLs** in the artifact:

- The compiled-in entry for the `cyweb` remote is a **sentinel, not a URL**. At
  load time the host publishes its own `remoteEntry.js` location on
  `window.__CYWEB_HOST__`, and the app-runtime's runtime plugin swaps it in —
  so one artifact works against `localhost`, `web.cytoscape.org`, or any other
  deployment.
- Chunk URLs resolve relative to wherever `remoteEntry.js` is served (Module
  Federation `publicPath: 'auto'`); the app can live at any origin and any base
  path (e.g. `https://example.org/apps/mcode/`).
- The MCODE web worker is **inlined** into the panel chunk (`?worker&inline`)
  and constructed from a Blob at runtime, so it needs no URL at all in
  production. In dev it is loaded from the dev server through a same-origin
  Blob shim (see [useMcodeWorker.ts](src/model/useMcodeWorker.ts)).

`dist/` **is** the bundle: serve the whole folder side by side at one base URL.
`remoteEntry.js` is the ESM container entry the host `import()`s; the exposed
module is `./AppConfig`; `mf-manifest.json` carries the federation metadata
(and what `npm run verify` checks against).

### Deployment gotchas

- **Shared deps are not bundled.** `react`, `react-dom`, `@mui/material`,
  `@emotion/react` and `@emotion/styled` are shared singletons with
  `import: false`: the remote consumes the **host's** copies. For the same
  reason, sources must import only the package roots (`'@mui/material'`, never
  `'@mui/material/Box'`), and `@mui/icons-material` is off-limits — the icons
  used by the panel are local `SvgIcon` wrappers in
  [icons.tsx](src/components/icons.tsx). The `noSharedPayload` build gate fails
  the build if any of these packages leak into the chunks.
- **Cross-origin serving needs CORS.** The host imports `remoteEntry.js` and
  its chunks cross-origin, so the files must be served with
  `Access-Control-Allow-Origin` (the dev server already sends `*`).
- **The remote type must stay ESM** to match the cyweb host's federation
  runtime. `cyweb-app verify` asserts this, along with the sentinel entry and
  the shared-singleton records.
