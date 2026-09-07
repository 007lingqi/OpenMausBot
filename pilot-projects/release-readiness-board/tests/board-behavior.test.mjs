import assert from 'node:assert/strict';
import test from 'node:test';
import {visibleChecks,checkCounts,toggleCheckReady,appendCheck} from '../app/release-board-state.ts';

const checks = [
  {id:'a',title:'支付回归',detail:'微信渠道',owner:'小林',area:'质量',due:'今天',priority:'P0',status:'ready'},
  {id:'b',title:'Alert',detail:'弱网重试',owner:'小陈',area:'后端',due:'明天',priority:'P1',status:'review'},
  {id:'c',title:'发布监控',detail:'告警待绑定',owner:'小周',area:'运维',due:'今天',priority:'P0',status:'blocked'},
];
test('状态筛选与关键词同时生效，支持标题、描述、负责人和领域', () => {
  assert.deepEqual(visibleChecks(checks,'review',' alert ').map(x=>x.id),['b']);
  assert.deepEqual(visibleChecks(checks,'ready','alert'),[]);
  for(const query of ['弱网','小陈','后端'])assert.deepEqual(visibleChecks(checks,'all',query).map(x=>x.id),['b']);
  assert.deepEqual(visibleChecks(checks,'blocked','').map(x=>x.id),['c']);
  assert.deepEqual(visibleChecks(checks,'all','   '),checks);
});
test('切换就绪状态仅影响指定事项，并准确更新状态统计', () => {
  const before=structuredClone(checks),next=toggleCheckReady(checks,'b');
  assert.equal(next[1].status,'ready');assert.equal(next[0],checks[0]);assert.equal(next[2],checks[2]);
  assert.deepEqual(checkCounts(next),{ready:2,review:0,blocked:1});
  assert.equal(toggleCheckReady(next,'b')[1].status,'review');
  assert.equal(toggleCheckReady(checks,'c')[2].status,'ready');
  assert.deepEqual(toggleCheckReady(checks,'missing'),checks);assert.deepEqual(checks,before);
});
test('新增检查项去掉首尾空格，默认为待复核，不接受空名称', () => {
  assert.equal(appendCheck(checks,'  '),checks);
  const next=appendCheck(checks,'  确认灰度名单  ');
  assert.equal(next.length,4);assert.equal(checks.length,3);
  assert.deepEqual(next[3],{id:'check-4',title:'确认灰度名单',detail:'新检查项，等待补充验收证据',owner:'待指派',area:'未分类',due:'未设置',priority:'P1',status:'review'});
  assert.deepEqual(checkCounts(next),{ready:1,review:2,blocked:1});
  assert.deepEqual(visibleChecks(next,'review','灰度').map(x=>x.title),['确认灰度名单']);
});
test('空清单返回空结果和零统计', () => {
  assert.deepEqual(visibleChecks([],'all',''),[]);assert.deepEqual(checkCounts([]),{ready:0,review:0,blocked:0});
  assert.equal(appendCheck([],'第一项')[0].id,'check-1');
});
