// Loads the browser scripts (which attach to `window`) into Node's global scope for unit tests.
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

globalThis.window = globalThis;
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function load(rel) {
  vm.runInThisContext(fs.readFileSync(ROOT + rel, 'utf8'), { filename: rel });
}
export async function fixture(name) {
  return fs.openAsBlob(ROOT + 'tests/fixtures/' + name);
}
