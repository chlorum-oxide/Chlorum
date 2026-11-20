// agents/tasks/scan.mjs — filesystem sweep from a root path
//
// args: { root, ext?: string[], limit?: number }
// Returns matching paths (capped). The console validates ext
// patterns before this ever runs; the node trusts nothing anyway.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export async function scan({ args }) {
  const root = args.root;
  const exts = new Set((args.ext || []).map((e) => e.toLowerCase()));
  const limit = Math.min(args.limit || 500, 2000);
  const matches = [];
  let visited = 0;

  function walk(dir, depth) {
    if (depth > 6 || matches.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= limit) return;
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else {
        visited += 1;
        if (exts.size === 0 || exts.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) {
          try {
            const st = statSync(full);
            matches.push({ path: full, size: st.size });
          } catch {
            matches.push({ path: full, size: -1 });
          }
        }
      }
    }
  }

  walk(root, 0);
  return { summary: `scan ${root}: ${matches.length} hits / ${visited} visited`, matches };
}
