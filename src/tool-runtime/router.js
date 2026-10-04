/**
 * Compatibility shim. The implementation moved to `src/tools/router.js` during the
 * migration (architecture §5, step 4); this file only forwards until `src/proxy.js` and
 * this directory are deleted.
 *
 * @module tool-runtime/router
 */

export * from '../tools/router.js';
