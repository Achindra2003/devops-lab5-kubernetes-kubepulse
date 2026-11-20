// Prints which Pod answered each request through the Service. Usage: node scripts/probe.js [count]
import { get } from './lib.js';

const n = parseInt(process.argv[2] || '10', 10);
for (let i = 1; i <= n; i++) {
  const d = await get();
  console.log(`request ${String(i).padStart(2)} -> pod=${d.pod}  node=${d.node}  version=${d.version}`);
}
