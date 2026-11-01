/**
 * A request's target as a proof names it: its path and its query, normalized exactly as the
 * request is sent -- an escape of an unreserved character decoded, every other escape in upper
 * case, a character a path or a query may not hold escaped as UTF-8, and dot segments removed.
 * The transport sends the same normalized target, so what is signed is what is sent.
 */

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const SUB_DELIMS = "!$&'()*+,;=";
const PATH_EXTRA = ':@/';
const QUERY_EXTRA = ':@/?';

function allowed(char: string, extra: string): boolean {
  return UNRESERVED.test(char) || SUB_DELIMS.includes(char) || extra.includes(char);
}

function isHex(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function escapeByte(byte: number): string {
  return '%' + (byte < 16 ? '0' : '') + byte.toString(16).toUpperCase();
}

function escapeCodePoint(code: number): string {
  const bytes: number[] = [];
  if (code < 0x80) {
    bytes.push(code);
  } else if (code < 0x800) {
    bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
  } else if (code < 0x10000) {
    bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  } else {
    bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes.map(escapeByte).join('');
}

function normalize(component: string, extra: string): string {
  let out = '';
  for (let i = 0; i < component.length; i++) {
    const char = component[i];
    const code = component.charCodeAt(i);
    if (code < 128 && allowed(char, extra)) {
      out += char;
    } else if (char === '%') {
      const valid = i + 2 < component.length &&
        isHex(component.charCodeAt(i + 1)) && isHex(component.charCodeAt(i + 2));
      if (!valid) {
        out += '%25';
        continue;
      }
      const value = parseInt(component.substr(i + 1, 2), 16);
      const decoded = String.fromCharCode(value);
      if (UNRESERVED.test(decoded)) {
        out += decoded;
      } else {
        out += component.substr(i, 3).toUpperCase();
      }
      i += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < component.length &&
      component.charCodeAt(i + 1) >= 0xdc00 && component.charCodeAt(i + 1) <= 0xdfff) {
      out += escapeCodePoint(0x10000 + ((code - 0xd800) << 10) + (component.charCodeAt(i + 1) - 0xdc00));
      i++;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      out += escapeCodePoint(0xfffd);
    } else {
      out += escapeCodePoint(code);
    }
  }
  return out;
}

function removeDotSegments(path: string): string {
  if (!(path.startsWith('.') || path.includes('/.'))) {
    return path;
  }
  const output: string[] = [];
  let appendSlash = false;
  for (const segment of path.split('/')) {
    appendSlash = false;
    if (segment === '..') {
      if (output.length > 0) {
        output.pop();
        if (output.length === 0) {
          output.push('');
        }
      }
      appendSlash = true;
    } else if (segment === '.') {
      appendSlash = true;
    } else {
      output.push(segment);
    }
  }
  if (appendSlash) {
    output.push('');
  }
  return output.join('/');
}

export interface Target {
  /** The path, without the query. */
  path: string;
  /** The query as sent, without its `?`; empty when there is none. */
  query: string;
  /** Whether the target has a `?` at all. */
  hasQuery: boolean;
}

/** [target] -- a path with its query, such as `/v1/items?limit=5` -- as a proof names it. */
export function parseTarget(target: string): Target {
  let rest = target;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    rest = rest.substring(0, hash);
  }
  const mark = rest.indexOf('?');
  const rawPath = mark >= 0 ? rest.substring(0, mark) : rest;
  const rawQuery = mark >= 0 ? rest.substring(mark + 1) : '';
  return {
    path: removeDotSegments(normalize(rawPath, PATH_EXTRA)),
    query: normalize(rawQuery, QUERY_EXTRA),
    hasQuery: mark >= 0,
  };
}

/** [target] as the transport sends it: the same normalized path and query. */
export function normalizedTarget(target: string): string {
  const parsed = parseTarget(target);
  return parsed.hasQuery ? `${parsed.path}?${parsed.query}` : parsed.path;
}
