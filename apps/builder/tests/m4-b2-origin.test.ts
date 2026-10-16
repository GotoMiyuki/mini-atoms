import test from 'node:test';import assert from 'node:assert/strict';import {configuredOrigin} from '../src/server/deployment-origin.ts';
test('B2 random Quick Tunnel hostname is one exact origin, never a domain-wide grant',()=>{
 const first='https://demo-alpha-beta-gamma.trycloudflare.com',second='https://demo-delta-epsilon-zeta.trycloudflare.com';assert.equal(configuredOrigin(first,8120),first);assert.equal(configuredOrigin(second,8120),second);assert.notEqual(configuredOrigin(first,8120),second);assert.equal(configuredOrigin('',8120),'http://127.0.0.1:8120');
 for(const bad of ['https://*.trycloudflare.com',first+'/',first+':443',first+'/preview',first+'?token=x',first+'#x',first.replace('https:','http:'),'https://owner@demo-alpha-beta-gamma.trycloudflare.com','https://DEMO-alpha-beta-gamma.trycloudflare.com'])assert.throws(()=>configuredOrigin(bad,8120));
});
