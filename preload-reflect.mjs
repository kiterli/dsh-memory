// One-shot: preload Qwen2.5-1.5B reflection model
import { createReflector } from './lib/reflection.js';
import path from 'node:path';
import os from 'node:os';

const cacheDir = path.join(os.homedir(), '.dsh', 'memory-models');
const reflector = createReflector({
  dbPath: ':memory:',
  cacheDir,
  hfMirror: 'https://hf-mirror.com',
  logger: console,
});

console.log('Starting model download...');
// Trigger lazy start by calling reflect with empty input
const result = await reflector.reflect([], []);
console.log('Reflector ready:', reflector.isReady(), 'Result:', result);
await reflector.dispose();
console.log('Done.');
process.exit(0);
