// Synthetic-only HTTP acceptance and reproducible browser fixture.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import argon2 from 'argon2';
if(process.env.ZY_BRIDGE_SYNTHETIC_TEST!=='1') throw new Error('Requires isolated synthetic test opt-in');
const base='http://127.0.0.1:8081', org=randomUUID(), owner=randomUUID(), reviewer=randomUUID();
const password='Synthetic-'+randomUUID(), hash=await argon2.hash(password);
execFileSync('docker',['exec','zy-finance-test-db-1','psql','-U','postgres','-d','zy','-v','ON_ERROR_STOP=1','-c',`INSERT INTO organizations VALUES('${org}','虚构第一批验收'); INSERT INTO users(id,org_id,username,name,role,password_hash,must_change_password) VALUES('${owner}','${org}','${owner}','虚构经办负责人','owner','${hash}',false),('${reviewer}','${org}','${reviewer}','虚构复核员','reviewer','${hash}',false);`],{stdio:'pipe'});
async function login(username){const r=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').match(/zy_session=([^;]+)/)[1],csrf:(await r.json()).csrf};}
const a=await login(owner), b=await login(reviewer);
async function req(auth,url,body){const r=await fetch(base+'/api/v1'+url,{method:body?'POST':'GET',headers:{cookie:'zy_session='+auth.cookie,'x-csrf-token':auth.csrf,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;}
const clients=[];
for(const basis of ['small_2011','enterprise'])for(const industry of ['trade','services']){
 const key=basis+'-'+industry, fixture=new URL('./fixtures/batch1/'+key+'/',import.meta.url);
 const sample=JSON.parse(await readFile(new URL('sample.json',fixture),'utf8'));
 const c=await req(a,'/clients/onboard',{name:sample.profile.legalName,code:'SYN-'+randomUUID(),profile:{contactName:'虚构联系人',contactPhone:'',serviceNotes:'统一验收样本'},checklist:[{name:'接账资料',required:true}],assigneeId:owner,reviewerId:reviewer,firstMonth:{period:'2026-01',dueDate:'2026-02-10'}});
 const route='/companies/'+c.id+'/dossier';
 const before=await req(a,route+'?period=2026-01');
 const form=new FormData();form.set('file',new Blob([await readFile(new URL('business-evidence.csv',fixture))]),'虚构原始业务记录.csv');
 const file=await req(a,route+'/documents?key='+randomUUID(),form);
 const ref={kind:'archive',id:file.id};
 const payload={...before.payload,...sample.profile,creditCode:'913205000000000001',evidence:[ref],intake:before.payload.intake.map(i=>({...i,status:'provided',note:'固定虚构样本；仅测试资料登记，数字详见仓库样本及独立计算说明',evidence:[ref]}))};
 const draft=await req(a,route+'/drafts',{version:0,companyVersion:before.company.version,key:randomUUID(),effectiveFrom:'2026-01',reason:'统一样本首次建档',payload});
 assert.equal((await req(a,route+'?period=2026-01')).selectedVersion,0);
 const revision=await req(b,route+'/drafts/'+draft.id+'/confirm',{version:0});
 const current=await req(a,route+'?period=2026-01');
 await req(b,route+'/bind',{period:'2026-01',revisionId:revision.id,orderVersion:current.order.version,reason:'确认虚构样本本月版本'});
 const final=await req(a,route+'?period=2026-01');
 assert.equal(final.bound,true);assert.deepEqual(final.gaps,[]);assert.equal(final.payload.reportingBasis,basis);assert.equal(final.payload.industry,industry);assert.equal(final.evidence[0].id,file.id);
 clients.push({id:c.id,key,revisionId:revision.id});
}
await mkdir('.test/results',{recursive:true});
await writeFile('.test/batch1-browser-state.json',JSON.stringify({cookies:[{name:'zy_session',value:a.cookie,domain:'127.0.0.1',path:'/',httpOnly:true,secure:false,sameSite:'Lax',expires:-1}],origins:[]}));
await writeFile('.test/results/batch1-http.json',JSON.stringify({synthetic:true,clients,passed:4},null,2));
console.log('4 fixed synthetic clients: draft, evidence, independent confirmation, monthly binding and no missing registration fields passed.');
