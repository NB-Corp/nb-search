// Project development helper, not a public SDK export or an installed runtime entry.
// Run with: node --experimental-transform-types scripts/lane-guidance.mjs
import { listBuiltInLaneGuidance } from '../src/lane-guidance.ts';
process.stdout.write(`${JSON.stringify(listBuiltInLaneGuidance(), null, 2)}\n`);
