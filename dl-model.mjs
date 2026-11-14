import path from 'node:path';
import { resolveModelFile, getLlama } from 'node-llama-cpp';

const modelFile = await resolveModelFile(
  'https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
  path.join(process.cwd(), '.models')
);

console.log('Model at:', modelFile);

// Quick test
const llama = await getLlama();
const model = await llama.loadModel({ modelPath: modelFile });
const context = await model.createContext();
const session = new (await import('node-llama-cpp')).LlamaChatSession({ context });
const response = await session.prompt('你好，一句话介绍你自己');
console.log('Response:', response.text);
process.exit(0);
