import { resolve } from 'node:path';
import { evaluateCutoverEvidenceFile } from '../src/migration-cutover-gate.js';

const argIndex = process.argv.indexOf('--evidence');
if (argIndex < 0 || !process.argv[argIndex + 1]) {
  console.error('用法：node scripts/migration-cutover-gate.js --evidence <evidence.json>');
  console.error('没有证据文件时默认阻止切换；本工具不连接数据库、不执行切换。');
  process.exitCode = 2;
} else {
  const result = await evaluateCutoverEvidenceFile(resolve(process.argv[argIndex + 1]));
  console.log(JSON.stringify(result, null, 2));
  if (!result.eligible) process.exitCode = 2;
}
