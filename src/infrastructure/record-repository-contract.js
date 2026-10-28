/**
 * Port contract shared by repository adapters. Methods may return values or Promises;
 * application services always await them. Production confirmation must be atomic.
 */
export const RECORD_REPOSITORY_REQUIRED_METHODS = Object.freeze([
  'listByUser', 'get', 'insert', 'replace', 'getHistory',
  'getIdempotentResult', 'saveIdempotentResult'
]);

export function inspectRecordRepository(repository) {
  const missingMethods = RECORD_REPOSITORY_REQUIRED_METHODS.filter(
    (method) => typeof repository?.[method] !== 'function'
  );
  return {
    ok: missingMethods.length === 0,
    missingMethods,
    supportsAtomicConfirm: typeof repository?.confirmAtomically === 'function',
    supportsReadiness: typeof repository?.checkReadiness === 'function',
  };
}

export function assertRecordRepository(repository, { requireAtomicConfirm = false } = {}) {
  const result = inspectRecordRepository(repository);
  if (!result.ok) {
    throw new TypeError(`记录仓储不符合契约，缺少方法：${result.missingMethods.join(', ')}`);
  }
  if (requireAtomicConfirm && !result.supportsAtomicConfirm) {
    throw new TypeError('生产环境记录仓储必须实现 confirmAtomically，以保证确认保存与幂等结果原子提交。');
  }
  return repository;
}
