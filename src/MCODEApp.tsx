/**
 * Update:
 *   1. `resources`   → add/remove panels and menu items
 *   2. `mount()`     → register context menus, event listeners, etc.
 *   3. `unmount()`   → clean up event listeners from mount()
 *
 * Identity (id, display name, version, description) arrives from
 * `virtual:cyweb-app-meta`, which the build fills in from the `cyweb` block
 * and standard fields in package.json — written once, read everywhere. Do NOT
 * `import packageJson from '../package.json'`: that pulls the whole file,
 * devDependencies included, into the browser bundle (`cyweb-app verify` fails
 * a build that does).
 *
 * Resources (panels and menu items) are registered declaratively — the host
 * renders them automatically. Context menus need `apis` access, so they are
 * registered in mount() instead.
 */

import { lazy } from 'react'

import { AppContext, CyAppWithLifecycle } from 'cyweb/ApiTypes'
import { description, displayName, id, version } from 'virtual:cyweb-app-meta'

import { mcodeClusterLayout } from './layout/mcodeClusterLayout'
import { setAppDataApi } from './model/mcodeAppData'

export const MCODEApp: CyAppWithLifecycle = {
  id, // the Module Federation container name, from `cyweb.id` in package.json
  name: displayName,
  description,
  version,
  apiVersion: '1.0',

  // ── Declarative resource registration ──────────────────────────────────
  // Panels and menu items are declared here. The host registers them
  // automatically — no mount() needed for these.
  resources: [
    {
      slot: 'right-panel',
      id: 'MCODEPanel',
      title: 'MCODE', // Tab title shown in the right panel.
      component: lazy(() => import('./components/MCODEPanel')),
    },
    // "MCODE Cluster Layout" in the Layout menu (app block), in Layout →
    // Settings... with its parameters, and as `mcode::cluster-layout` to
    // `layout.applyLayout`. Requires a host with the 'layout-algorithm' slot
    // (cytoscape-web#734); see src/layout/mcodeClusterLayout.ts.
    { slot: 'layout-algorithm', ...mcodeClusterLayout },
  ],

  // ── Lifecycle hooks ────────────────────────────────────────────────────
  // mount() is called once after the app's resources are registered.
  // Use it for context menus (handlers need api access) and event listeners.

  mount(context: AppContext): void {
    // Per-app storage for the MCODE results, keyed by network id. Handed to a
    // module-level holder because the store subscription that writes them runs
    // outside React; a component can use `useAppDataApi()` instead.
    //
    // `appData` entries are NOT cleaned up when the app is disabled — they are
    // results the user paid compute for. See src/model/mcodeAppData.ts.
    setAppDataApi(context.apis.appData)

    // Context menu items are registered here because their handlers need
    // access to context.apis. The host auto-cleans all items when the app
    // is disabled — no explicit removal in unmount() needed.
    // registerSelectNeighbors(context)

    // TODO: Add more context menu registrations or event listeners here.
    // See src/contextMenus.ts for the pattern.
  },

  unmount(): void {
    // Stop persisting. The stored entries stay — a disabled app's results are
    // still there when it is re-enabled.
    setAppDataApi(null)

    // Only manual cleanup (e.g. event listeners) goes here.
    // Context menu items and resources are auto-cleaned by the host.
    //
    // if (_handler !== null) {
    //   window.removeEventListener('network:switched', _handler)
    //   _handler = null
    // }
  },
}
