/** Version.gs — single source of the CDP app version.
 *
 * Bump BOTH values on every release. The header shows the build
 * stamp, and CDP_BUILD also keys the derived-data caches (records
 * cache in .cdp-cache), so a bump makes every parser fix take
 * effect on push with no stale parses surviving (design record
 * decision 29).
 *
 * Remember: /dev serves the latest push; /exec serves the last
 * "New version" deployment. The header version on /exec tells you
 * which release the operators have.
 */
var APP_VERSION = 'v2.16.1';
var APP_VERSION_DATE = '2026-11-13';

// Build stamp shown in the header and used in cache keys.
var CDP_BUILD = APP_VERSION + '-' + APP_VERSION_DATE;

function getVersion() {
  return { version: APP_VERSION, date: APP_VERSION_DATE };
}
