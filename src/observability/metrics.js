/**
 * Dependency-free metrics registry with a Prometheus text-exposition renderer.
 *
 * Only aggregate, non-identifying values may be recorded here: never record record
 * ids, user ids, tokens, connection strings or payload content. Label values are
 * escaped for the exposition format, but callers must still keep them low-cardinality.
 */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const LABEL_PATTERN = /^[a-z][a-z0-9_]*$/;
const METRIC_TYPES = new Set(['counter', 'gauge']);

function assertMetricName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new TypeError(`metric name must be lowercase snake_case: ${String(name)}`);
  }
}

function assertLabels(labels) {
  if (labels === undefined) return {};
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new TypeError('metric labels must be a plain object');
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_PATTERN.test(key)) throw new TypeError(`invalid metric label name: ${key}`);
    if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`metric label ${key} must be a string or number`);
    if (String(value).length > 200) throw new TypeError(`metric label ${key} is too long`);
  }
  return labels;
}

function assertValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('metric values must be finite non-negative numbers');
  }
  return value;
}

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function seriesKey(name, labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return name;
  return `${name}{${keys.map((key) => `${key}="${escapeLabelValue(labels[key])}"`).join(',')}}`;
}

export function createMetricsRegistry() {
  const series = new Map();
  const descriptors = new Map();

  function describe(name, { type = 'gauge', help = '' } = {}) {
    assertMetricName(name);
    if (!METRIC_TYPES.has(type)) throw new TypeError(`unsupported metric type: ${type}`);
    descriptors.set(name, { type, help: String(help) });
    return registry;
  }

  function set(name, value, labels = {}) {
    assertMetricName(name);
    const safeLabels = assertLabels(labels);
    const descriptor = descriptors.get(name);
    series.set(seriesKey(name, safeLabels), {
      name,
      labels: safeLabels,
      type: descriptor?.type ?? 'gauge',
      value: assertValue(value),
    });
    return registry;
  }

  function inc(name, labels = {}, delta = 1) {
    assertMetricName(name);
    const safeLabels = assertLabels(labels);
    const key = seriesKey(name, safeLabels);
    const current = series.get(key);
    const next = (current?.value ?? 0) + Number(delta);
    series.set(key, {
      name,
      labels: safeLabels,
      type: descriptors.get(name)?.type ?? 'counter',
      value: assertValue(next),
    });
    return registry;
  }

  function observeHttpRequest(method, statusCode) {
    inc('health_skill_http_requests_total', {
      method: String(method || 'UNKNOWN').toUpperCase(),
      status: String(statusCode ?? 0),
    });
    return registry;
  }

  function render() {
    const grouped = new Map();
    for (const entry of series.values()) {
      if (!grouped.has(entry.name)) grouped.set(entry.name, []);
      grouped.get(entry.name).push(entry);
    }
    const lines = [];
    for (const name of [...grouped.keys()].sort()) {
      const descriptor = descriptors.get(name);
      if (descriptor) {
        if (descriptor.help) lines.push(`# HELP ${name} ${descriptor.help.replace(/\n/g, ' ')}`);
        lines.push(`# TYPE ${name} ${descriptor.type}`);
      }
      const points = grouped.get(name).sort((a, b) => seriesKey(a.name, a.labels).localeCompare(seriesKey(b.name, b.labels)));
      for (const point of points) lines.push(`${seriesKey(point.name, point.labels)} ${point.value}`);
    }
    return `${lines.join('\n')}\n`;
  }

  function snapshot() {
    return Object.fromEntries([...series.entries()].map(([key, entry]) => [key, entry.value]));
  }

  const registry = { describe, set, inc, observeHttpRequest, render, snapshot };
  return registry;
}
