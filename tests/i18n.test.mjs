import test from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, translate, readLanguage } from '../extension/i18n.mjs';
test('both languages contain identical message keys and placeholders',()=>{
  assert.deepEqual(Object.keys(dictionaries.en).sort(),Object.keys(dictionaries['zh-CN']).sort());
  for(const key of Object.keys(dictionaries.en)){
    const placeholders=s=>(s.match(/\{\w+\}/g)||[]).sort();
    assert.deepEqual(placeholders(dictionaries.en[key]),placeholders(dictionaries['zh-CN'][key]),key);
  }
});
test('first launch defaults to English independently of browser locale',()=>assert.equal(readLanguage(),'en'));
test('variable messages are translated',()=>{
  assert.equal(translate('en','selectAll',{n:500}),'Select all 500');
  assert.equal(translate('zh-CN','selectAll',{n:500}),'全选 500 项');
});
