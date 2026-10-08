/* global module, URLSearchParams */
// SDK 57 backport of Expo PR #50725. Keep the namespace API its compiled router uses.
// https://github.com/expo/expo/pull/50725
/** @param {Record<string, unknown>} params
 * @param {{ sort?: false }} [options] */
function stringify(params, options = {}) {
  if (options.sort !== undefined && options.sort !== false) {
    throw new Error('Unsupported Expo Router query sorting');
  }
  const searchParams = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) {
          searchParams.append(name, item === null ? '' : String(item));
        }
      }
    } else if (value !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Upstream serializes arbitrary scalar route values.
      searchParams.append(name, value === null ? '' : String(value));
    }
  }
  return searchParams.toString();
}

// The SDK 57 bundled React Navigation parser still needs the namespace parse API.
// Use the platform decoder rather than the vulnerable recursive percent decoder.
/** @param {string} query */
function parse(query) {
  /** @type {Record<string, string | null | (string | null)[]>} */
  const result = {};
  Object.setPrototypeOf(result, null);
  for (const part of query
    .trim()
    .replace(/^[?#&]/, '')
    .split('&')) {
    if (!part) continue;
    const entry = new URLSearchParams(part).entries().next().value;
    if (!entry) continue;
    const [key, value] = entry;
    const decoded = part.includes('=') ? value : null;
    if (Object.hasOwn(result, key)) {
      const previous = result[key];
      if (Array.isArray(previous)) previous.push(decoded);
      else result[key] = [previous ?? null, decoded];
    } else {
      result[key] = decoded;
    }
  }
  /** @type {Record<string, string | null | (string | null)[]>} */
  const sorted = {};
  Object.setPrototypeOf(sorted, null);
  for (const [key, value] of Object.entries(result).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    sorted[key] = value;
  return sorted;
}

module.exports = { stringify, parse };
