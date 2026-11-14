/**
 * 下载本地推演模型（Qwen2.5-1.5B-Instruct GGUF），用于 reflection 模块提炼经验。
 *
 * 这是一个**可选**步骤：
 *   - 不装模型，插件照常工作（反思/提炼这些能力降级，记忆存取不受影响）
 *   - 装模型需要 devDependency `node-llama-cpp`，它不在默认安装范围内
 *
 * 用法：
 *   npm install --include=dev      # 先装开发依赖
 *   npm run dl-model
 */
import path from 'node:path';

let llamaModule;
try {
  llamaModule = await import('node-llama-cpp');
} catch (err) {
  const code = err && err.code;
  console.error('');
  console.error('找不到 node-llama-cpp，无法下载模型。');
  console.error('');
  console.error('这个模型是可选的：不装它插件也能用，只是少了本地反思/提炼能力。');
  console.error('');
  console.error('要装的话：');
  console.error('  npm install --include=dev');
  console.error('  npm run dl-model');
  console.error('');
  console.error(`原始错误：${code ?? ''} ${err && err.message ? err.message : err}`);
  process.exit(1);
}

const { resolveModelFile, getLlama, LlamaChatSession } = llamaModule;

const modelFile = await resolveModelFile(
  'https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
  path.join(process.cwd(), '.models'),
);

console.log('Model at:', modelFile);

// Quick test
const llama = await getLlama();
const model = await llama.loadModel({ modelPath: modelFile });
const context = await model.createContext();
const session = new LlamaChatSession({ context });
const response = await session.prompt('你好，一句话介绍你自己');
console.log('Response:', response.text);
process.exit(0);
