import test from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, translate, readLanguage } from '../extension/i18n.mjs';
import { translateRecommendationSettings } from '../extension/recommendation-copy.mjs';
test('both languages contain identical message keys and placeholders',()=>{
  assert.deepEqual(Object.keys(dictionaries.en).sort(),Object.keys(dictionaries['zh-CN']).sort());
  for(const key of Object.keys(dictionaries.en)){
    const placeholders=s=>[...s.matchAll(/\{(\w+)(?::[^{}]+)?\}/g)].map(match=>match[1]).sort();
    assert.deepEqual(placeholders(dictionaries.en[key]),placeholders(dictionaries['zh-CN'][key]),key);
  }
});
test('first launch defaults to English independently of browser locale',()=>assert.equal(readLanguage(),'en'));
test('variable messages are translated',()=>{
  assert.equal(translate('en','selectAll',{n:500}),'Select all 500');
  assert.equal(translate('zh-CN','selectAll',{n:500}),'全选 500 项');
});
test('English counts use singular only for one, including formatted count strings',()=>{
  for (const n of [0, 1, 2, '1', '1,000']) {
    const one = String(n) === '1';
    assert.equal(translate('en', 'resultCount', { n }), `${n} ${one ? 'result' : 'results'}`);
    assert.equal(translate('en', 'siteCount', { n }), `From ${n} ${one ? 'website' : 'websites'}`);
    assert.equal(translate('en', 'siteItems', { n }), `${n} ${one ? 'page' : 'pages'}`);
    assert.equal(translateRecommendationSettings('en', 'ruleCount', { n }), `${n} ${one ? 'rule' : 'rules'}`);
    assert.equal(translate('zh-CN', 'resultCount', { n }), `${n} 条结果`);
    assert.equal(translateRecommendationSettings('zh-CN', 'ruleCount', { n }), `${n}条规则`);
  }
});
test('deletion previews pluralize URL and website counts independently',()=>{
  assert.equal(translate('en', 'previewSummary', { n: '1', sites: '1' }), '1 URL across 1 website');
  assert.equal(translate('en', 'previewSummary', { n: '2', sites: '1' }), '2 URLs across 1 website');
  assert.equal(translate('en', 'previewSummary', { n: '1', sites: '2' }), '1 URL across 2 websites');
  assert.match(translate('en', 'confirmBody', { n: '1' }), /1 selected URL\./);
  assert.match(translate('en', 'confirmBody', { n: '2' }), /2 selected URLs\./);
});
test('recommended cleanup counts render once and pluralize their own scope',()=>{
  for (const n of [0, 1, 6]) {
    assert.equal(translate('en', 'cleanupItemCount', { n }), `${n} ${n === 1 ? 'item' : 'items'}`);
    assert.equal(translate('en', 'cleanupSelectedLabel', { n }), `Clean ${n} selected recommended ${n === 1 ? 'record' : 'records'}`);
    assert.equal(translate('en', 'cleanupCompleted', { n }), `Cleaned ${n} recommended ${n === 1 ? 'record' : 'records'}`);
    assert.equal(translate('zh-CN', 'cleanupItemCount', { n }), `${n} 项`);
  }
  assert.equal(translate('en', 'cleanupPartial', { n: 2, total: 1 }), 'Cleaned 2; 1 recommendation remains');
  assert.equal(translate('en', 'cleanupFailed', { n: 1 }), 'Could not remove 1 record. Your selection is kept for another attempt.');
});
