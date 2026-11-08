import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLink, validateLinkRule, validateWorkspaceTools, workspaceDefaults } from '../extension/workspace-tools.mjs';

const legacy = { hostname: 'example.com', parameters: ['utm_source', 'utm_campaign'] };

test('legacy rules normalize with enabled defaults and preserve their cleanup behavior', () => {
  assert.deepEqual(validateLinkRule(legacy), {
    hostname: 'example.com', parameters: ['utm_source', 'utm_campaign'], enabled: true,
    preserveParameters: [], excludedPaths: []
  });
  assert.deepEqual(cleanLink('https://example.com/p?utm_source=x&keep=a#section', legacy), {
    url: 'https://example.com/p?keep=a#section', removed: ['utm_source']
  });
  assert.deepEqual(validateWorkspaceTools({ ...workspaceDefaults(), linkRules: [legacy] }).linkRules[0],
    validateLinkRule(legacy));
});

test('optional fields validate, deduplicate and retain legal false', () => {
  assert.deepEqual(validateLinkRule({ ...legacy, enabled: false, preserveParameters: ['x', 'x'], excludedPaths: ['/x', '/x'] }), {
    hostname: 'example.com', parameters: legacy.parameters, enabled: false,
    preserveParameters: ['x'], excludedPaths: ['/x']
  });
  for (const override of [
    { enabled: 'false' }, { preserveParameters: 'x' }, { preserveParameters: [null] },
    { excludedPaths: '/' }, { excludedPaths: [null] }, { excludedPaths: ['/x?q=1'] },
    { excludedPaths: ['/x#fragment'] }, { other: true }
  ]) assert.throws(() => validateLinkRule({ ...legacy, ...override }), /INVALID_WORKSPACE_SETTINGS/);
  assert.throws(() => validateLinkRule({ ...legacy, preserveParameters: ['x'.repeat(257)] }), /INVALID_WORKSPACE_SETTINGS/);
});

test('preserved names take priority over removal with exact case matching', () => {
  const rule = { ...legacy, parameters: ['token', 'Token'], preserveParameters: ['token'] };
  assert.deepEqual(cleanLink('https://example.com/?token=a&Token=b&token=c', rule), {
    url: 'https://example.com/?token=a&token=c', removed: ['Token']
  });
});

test('excluded paths match segment boundaries and serialized encoded paths', () => {
  const rule = { ...legacy, excludedPaths: ['/checkout', '/encoded%2Fpart'] };
  for (const path of ['/checkout', '/checkout/item', '/encoded%2Fpart/item']) {
    const url = `https://example.com${path}?utm_source=x#frag`;
    assert.deepEqual(cleanLink(url, rule), { url, removed: [], skip: 'path' });
  }
  assert.deepEqual(cleanLink('https://example.com/checkout-v2?utm_source=x', rule), {
    url: 'https://example.com/checkout-v2', removed: ['utm_source']
  });
  assert.deepEqual(cleanLink('https://example.com/encoded%2fpart?utm_source=x', rule), {
    url: 'https://example.com/encoded%2fpart', removed: ['utm_source']
  });
});

test('root and trailing-slash exclusions cover their intended path prefixes', () => {
  const rootRule = { ...legacy, excludedPaths: ['/'] };
  const url = 'https://example.com/anything?utm_source=x';
  assert.deepEqual(cleanLink(url, rootRule), { url, removed: [], skip: 'path' });
  const nestedRule = { ...legacy, excludedPaths: ['/account/'] };
  assert.deepEqual(cleanLink('https://example.com/account/settings?utm_source=x', nestedRule), {
    url: 'https://example.com/account/settings?utm_source=x', removed: [], skip: 'path'
  });
  assert.deepEqual(cleanLink('https://example.com/account?utm_source=x', nestedRule), {
    url: 'https://example.com/account', removed: ['utm_source']
  });
});

test('disabled rules and excluded paths preserve the input exactly', () => {
  const url = 'https://example.com/a?utm_source=x#fragment';
  assert.deepEqual(cleanLink(url, { ...legacy, enabled: false }), { url, removed: [], skip: 'disabled' });
});

test('query cleanup removes repeated, empty and encoded targets while preserving raw untouched bytes', () => {
  const url = 'https://example.com/?utm_source=a&utm_source=&keep=%2f+z&u%74m_source=%E2%9C%93#frag%2F';
  const result = cleanLink(url, legacy);
  assert.deepEqual(result, { url: 'https://example.com/?keep=%2f+z#frag%2F', removed: ['utm_source'] });
  assert.deepEqual(cleanLink(result.url, legacy), { url: result.url, removed: [] });
});

test('no query, no matching parameter and malformed encoded names preserve original bytes', () => {
  for (const url of [
    'https://example.com/path#frag',
    'https://example.com/path?other=%2f+value#frag%2F',
    'https://example.com/path?%E0%A4%A=x&utm_source=a'
  ]) {
    if (url.includes('utm_source=a')) {
      assert.deepEqual(cleanLink(url, legacy), { url: url.replace('&utm_source=a', ''), removed: ['utm_source'] });
    } else assert.deepEqual(cleanLink(url, legacy), { url, removed: [] });
  }
});
