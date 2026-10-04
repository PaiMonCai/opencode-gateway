/**
 * Compatibility shim. The implementation moved to `src/tools/contract.js` during the
 * migration (architecture §5, step 4); this file only forwards the old `contracts.js`
 * specifier until `src/proxy.js` and this directory are deleted.
 *
 * @module tool-runtime/contracts
 */

export * from '../tools/contract.js';
