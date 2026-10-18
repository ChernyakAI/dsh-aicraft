import {test} from 'node:test'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import {accountingProjection as unit, intervalUnion} from '../.build/host/accounting.js'
import {priceRequest,isPeakTime} from '../.build/host/pricing.js'
import {StatisticsController} from '../.build/host/statistics.js'
const BASE=Date.parse('2026-10-15T12:00:00Z')
const usage=(i=100,r=50,o=20)=>({inputTokens:i,cacheReadTokens:r,cacheWriteTokens:0,outputTokens:o,totalTokens:i+r+o})
const evt=(type,data={},seq=0,time=BASE+seq*100)=>({type,data,seq,time})
const message=(u=usage())=>({turn:1,step:1,usage:u,message:{source:{provider:'deepseek-official',model:'deepseek-flash'}},stream:[]})
const events=(u=usage())=>[
 evt('aicraft/accounting',{version:1}),evt('turn/start',{turn:1},1),evt('step/start',{turn:1,step:1},2),
 evt('request/header',{header:{config:{provider:'deepseek-official',model:'deepseek-flash'}}},3),
 evt('assistant/message',message(u),4),evt('step/end',{turn:1,step:1},5),evt('turn/end',{turn:1,reason:{kind:'completed'}},6),
]
const fold=(items,boundary=0)=>items.reduce((s,e)=>unit.apply(s,e),unit.init({},boundary))
test('owned fork usage excludes seed, retains routing context and never adds reasoning twice',()=>{
 const parent=events(),child=events(usage(10,5,2)).map((e,i)=>({...e,seq:parent.length+i}))
 const own=fold([...parent,...child],parent.length)
 assert.equal(own.totals.total,17);assert.equal(own.totals.requests,1);assert.equal(own.tracked,true)
 const plain=fold(parent);assert.equal(plain.totals.total,170);assert.equal(plain.totals.input,150)
 const noOwnMarker=fold([...parent,...child.slice(1)],parent.length)
 assert.equal(noOwnMarker.tracked,false)
 const reasoning=events({...usage(),reasoningTokens:12});assert.equal(fold(reasoning).totals.output,20)
})
test('stream/final samples replace, started retries add and scheduled retries do not invent requests',()=>{
 const items=events();items.splice(4,0,evt('assistant/attempt',{turn:1,step:1,stream:[{type:'chunk',chunk:{type:'usage',usage:usage(20,10,5)}}]}))
 items.forEach((e,i)=>e.seq=i);assert.equal(fold(items).totals.total,170)
 const retry=events().slice(0,4)
 retry.push(evt('assistant/attempt',{turn:1,step:1,stream:[{type:'chunk',chunk:{type:'usage',usage:usage()}}]}),evt('llm/retry',{turn:1,step:1}))
 const stopped=[...retry,evt('step/end'),evt('turn/end')];stopped.forEach((e,i)=>e.seq=i)
 assert.equal(fold(stopped).totals.total,170);assert.equal(fold(stopped).totals.requests,1)
 retry.push(evt('llm/retry-started',{turn:1,step:1}),evt('assistant/message',message(usage(40,20,10))),evt('step/end'),evt('turn/end'))
 retry.forEach((e,i)=>e.seq=i);assert.equal(fold(retry).totals.total,240);assert.equal(fold(retry).totals.requests,2)
 assert.deepEqual(fold(retry).totals,fold(retry).totals)
})
test('absent/inconsistent usage and unknown cache are not reported as complete zero',()=>{
 const absent=events();absent[4]=evt('assistant/attempt',{turn:1,step:1,stream:[]},4)
 const missing=fold(absent).totals;assert.equal(missing.total,0);assert.equal(missing.unknownUsage,1)
 const local=absent.map(e=>e.type==='request/header'?{...e,data:{header:{config:{provider:'lmstudio',model:'local'}}}}:e)
 assert.equal(fold(local).totals.local,1);assert.equal(fold(local).totals.unknownPrice,0)
 const unknown=fold(events({inputTokens:100,outputTokens:20,totalTokens:170})).totals
 assert.equal(unknown.total,170);assert.equal(unknown.unknownUsage,0);assert.equal(unknown.unknownCache,1);assert.equal(unknown.unknownPrice,1)
 const bad=fold(events({...usage(),totalTokens:2})).totals;assert.equal(bad.unknownUsage,1)
 assert.equal(fold(events({inputTokens:100,outputTokens:20,totalTokens:120})).totals.unknownCache,1)
})
test('prices use actual provider/model/time, UTC peak windows, holidays and conservative coverage',()=>{
 const u={input:1000000,cacheRead:1000000,cacheWrite:0,output:1000000}
 const off=priceRequest('deepseek-official','deepseek-flash',Date.parse('2026-10-15T12:00:00Z'),u)
 const peak=priceRequest('deepseek-official','deepseek-flash',Date.parse('2026-10-15T01:00:00Z'),u)
 assert.equal(off.kind,'priced');assert.equal(off.uncached,150000000);assert.equal(off.cache,3000000);assert.equal(off.output,600000000)
 assert.equal(peak.uncached,off.uncached*2)
 assert.equal(isPeakTime(Date.parse('2026-10-01T01:00:00Z')),false)
 assert.equal(isPeakTime(Date.parse('2026-10-10T01:00:00Z')),false) // makeup Saturday is still outside Mon–Fri tariff rule.
 assert.equal(isPeakTime(Date.parse('2026-10-15T04:00:00Z')),false)
 assert.equal(isPeakTime(Date.parse('2026-10-15T06:00:00Z')),true)
 assert.equal(isPeakTime(Date.parse('2026-10-15T10:00:00Z')),false)
 assert.equal(priceRequest('deepseek-official','deepseek-flash',Date.parse('2026-10-14T01:00:00Z'),u).kind,'priced')
 assert.equal(priceRequest('custom','deepseek-flash',BASE,u).kind,'unknown')
 assert.equal(priceRequest('lmstudio','arbitrary',BASE,u).kind,'local')
 assert.equal(priceRequest('deepseek-official','deepseek-flash',BASE,{...u,cacheWrite:2}).kind,'unknown')
 assert.equal(priceRequest('deepseek-official','deepseek-flash',Date.parse('2027-01-04T01:00:00Z'),u).kind,'unknown')
})
test('activity unions omit human pauses and do not multiply concurrent roots',()=>{
 assert.equal(intervalUnion([[0,100],[50,150],[300,400]]),250)
 assert.equal(intervalUnion([]),0)
})
function fixture(){
 const state={taskType:'feature',taskIdentifier:'t',taskTitle:'Task',status:'open',stepStates:[{id:'analysis',status:'current'}]}
 const run=id=>({id:'run-'+id,stepId:'analysis',sessionId:id,status:'completed',startedAt:'2026-10-15T12:00:00Z',finishedAt:'2026-10-15T12:00:01Z',outputPath:'.aicraft/tasks/t/analysis',model:{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:null},error:null})
 const docs={'state.json':state,'process.json':{name:'Feature',steps:[{id:'analysis',title:'Analysis',role:'analyst'}]},'runs.json':[run('a'),run('b')]}
 const packets=new Map([['a',{state:fold(events()),catalog:[{id:'child',mode:'continuable'}],stats:{llmMs:100,toolMs:50}}],['b',{state:fold(events(usage(10,5,2))),catalog:[{id:'child',mode:'continuable'}],stats:{llmMs:200,toolMs:70}}],['child',{state:fold(events(usage(1,0,1))),catalog:[],stats:{llmMs:999,toolMs:999}}]])
 let created
 const ctx={get(key){return this[key]},fs:{async lstat(){return undefined},async resolve(path,{cwd='/project'}={}){return resolve(cwd,path)},contains(root,target){const rel=relative(root,target);return rel===''||(!rel.startsWith('..')&&!rel.startsWith('/'))},async stat(path){return docs[path.split('/').at(-1)]?{type:'file'}:undefined},async readText(path){return JSON.stringify(docs[path.split('/').at(-1)])}},effect(fn){return fn()},on(name,handler){if(name==='agent/created'){created=handler;this.created=handler};if(name==='agent/disposed')this.disposed=handler;return()=>{}},agents:{get(){}},sessionProjections:{register(){return()=>{}},stateOf(session){return session.state}},sessionQuery:{async observeSession(id){const p=packets.get(id);if(!p)throw new Error('missing');return {get events(){throw new Error('Must use the saved projection, not copy raw logs')},source:'prepared',projections:{values:{aicraftAccounting:p.state,sessionStats:p.stats,subagentCatalog:p.catalog}},[Symbol.dispose](){}}}}}
 return {controller:new StatisticsController(ctx),ctx,packets,created}
}
test('task totals union all roots and descendants once, keep child times out and validate requested roots',async()=>{
 const {controller,packets}=fixture(),signal=new AbortController().signal
 const all=await controller.read('/project','t',null,signal)
 assert.equal(all.total,189);assert.equal(all.sessions,3);assert.equal(all.llmMs,300);assert.equal(all.toolMs,120)
 assert.equal(all.elapsedMs,500);assert.deepEqual(all.incomplete,[])
 const single=await controller.read('/project','t','a',signal);assert.equal(single.total,172)
 await assert.rejects(controller.read('/project','t','unrelated',signal),/belong/)
 await assert.rejects(controller.read('/project','../t',null,signal),/Invalid/)
 packets.get('a').state.tracked=false;packets.delete('child')
 const partial=await controller.read('/project','t',null,signal)
 assert.equal(partial.total,187);assert.ok(partial.incomplete.some(s=>s.includes('Earlier')));assert.ok(partial.incomplete.some(s=>s.includes('unavailable')))
})
test('accounting survives controller restart outside the chat log, including native children and opaque delegations',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'aicraft-accounting-'))
 try{
  await mkdir(join(cwd,'.aicraft'))
  const {controller,ctx,created,packets}=fixture(),handlers={},docs=new Map()
  const fs={
   async resolve(path,{cwd:base=cwd}={}){return resolve(base,path)},
   contains(root,path){const rel=relative(root,path);return !rel.startsWith('..')},
   async lstat(path){return docs.has(path)?{type:'file'}:undefined},
   async stat(path){return docs.has('.aicraft/accounting.json')&&path.endsWith('/accounting.json')?{type:'file',version:String(docs.get('.aicraft/accounting.json'))}:undefined},
   async readBytes(){return Buffer.from(docs.get('.aicraft/accounting.json'))},
   async writeText(path,text){docs.set('.aicraft/accounting.json',text)},
  }
  const originalStat=ctx.fs.stat
  const trackingStat=fs.stat
  fs.stat=async path=>path.endsWith('/accounting.json')?trackingStat(path):originalStat(path)
  ctx.fs={...ctx.fs,...fs}
  const session={id:'root',header:{cwd},append(){throw new Error('Must not append plugin events to chat history')}}
  let detached=0
  const disposed=ctx.disposed
  const agent={session,ctx:{on(name,fn){handlers[name]=fn;return()=>{detached++}}}}
  await controller.track(agent)
  await handlers['subagent/start']({id:'opaque',local:false,provider:'codex'})
  let saved=JSON.parse(docs.get('.aicraft/accounting.json'))
  assert.deepEqual(saved.sessions,[{id:'root',children:[{id:'opaque',local:false,provider:'codex'}]}])
  const other={session:{id:'other',header:{cwd}},ctx:{}}
  await created({agent:other});assert.equal(JSON.parse(docs.get('.aicraft/accounting.json')).sessions.length,1)
  const child={session:{id:'child',header:{cwd,parentSession:'root',origin:'subagent'},append:session.append},ctx:{on(){return()=>{}}}}
  ctx.agents.get=()=>agent;await created({agent:child})
  saved=JSON.parse(docs.get('.aicraft/accounting.json'));assert.equal(saved.sessions[1].id,'child')
  const restarted=new StatisticsController(ctx)
  const restored={session,ctx:{on(name,fn){handlers[name]=fn;return()=>{}}}}
   await ctx.created({agent:restored})
  await handlers['subagent/start']({id:'second',local:false,provider:'claude-code'})
  assert.equal(JSON.parse(docs.get('.aicraft/accounting.json')).sessions[0].children.length,2)
  packets.set('a',{state:unit.init({},0),catalog:[],stats:{llmMs:0,toolMs:0}})
  await controller.track({session:{id:'a',header:{cwd},append:session.append},ctx:{on(){return()=>{}}}})
  assert.equal((await restarted.read(cwd,'t','a',new AbortController().signal)).coverageIncomplete,false)
  assert.equal(detached,0);await disposed({agent});assert.equal(detached,1,'Disposing an agent removes its plugin-owned delegation listener')
  await disposed({agent});assert.equal(detached,1,'Repeated disposal is harmless')
 }finally{await rm(cwd,{recursive:true,force:true})}
})

test('native DSH projection checkpoint restores the same totals without replay double counting',async()=>{
 const {Context}=await import('@deepseek-ai/cordis')
 const {default:SessionStore}=await import('@deepseek-ai/dsh-session')
 const {default:Registry}=await import('@deepseek-ai/dsh-session-projection')
 const {createAssistantMessage}=await import('@deepseek-ai/dsh-llm')
 const ctx=new Context()
 const store=await ctx.plugin(SessionStore),registry=await ctx.plugin(Registry)
 const unregister=ctx.sessionProjections.register(unit)
 const session=ctx.sessions.create()
 for(const e of events()){
   const data=e.type==='assistant/message'?{...e.data,message:createAssistantMessage({content:[{type:'text',text:'test'}],source:{provider:'deepseek-official',model:'deepseek-flash'}})}:e.data
   session.append(e.type,data,e.type==='assistant/message'?{surfaceOp:'append'}:undefined)
 }
 const before=ctx.sessionProjections.snapshot(session).values.aicraftAccounting
 assert.equal(before.totals.total,170)
 const checkpoint=ctx.sessionProjections.checkpoint(session)
 const restored=ctx.sessionProjections.restore(checkpoint,session.snapshotEvents(),0,session.header,session.inheritedEventCount)
 assert.deepEqual(restored.snapshot.values.aicraftAccounting,before)
 unregister();await registry.dispose();await store.dispose()
})


test('statistics admission bounds concurrent reads and releases slots after cancellation',async()=>{
 const {controller,ctx}=fixture(),original=ctx.sessionQuery.observeSession
 let active=0,maximum=0
 ctx.sessionQuery.observeSession=async(...args)=>{
   active++;maximum=Math.max(maximum,active)
   try{await new Promise(resolve=>setTimeout(resolve,5));return await original(...args)}finally{active--}
 }
 const abort=new AbortController()
 const calls=[controller.read('/project','t',null,new AbortController().signal),controller.read('/project','t',null,new AbortController().signal),controller.read('/project','t',null,abort.signal)]
 abort.abort()
 const results=await Promise.allSettled(calls)
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'fulfilled');assert.equal(results[2].status,'rejected')
 assert.ok(maximum<=2)
 assert.equal((await controller.read('/project','t','a',new AbortController().signal)).total,172)
})


test('unchanged persisted sessions reuse compact packets and a revision change invalidates only that session',async()=>{
 const {controller,ctx,packets}=fixture(),original=ctx.sessionQuery.observeSession,revisions=new Map([['a','1'],['b','1'],['child','1']]),reads=[]
 ctx.sessionPersistence={identity:Symbol('store'),async stat(id){return {revision:revisions.get(id)}}}
 ctx.sessionQuery.observeSession=async(id)=>{
   reads.push(id);const result=await original(id);Object.defineProperty(result,'revision',{value:revisions.get(id)});return result
 }
 const signal=new AbortController().signal
 assert.equal((await controller.read('/project','t',null,signal)).total,189)
 assert.equal((await controller.read('/project','t',null,signal)).total,189)
 assert.equal(reads.length,3)
 packets.get('child').state=fold(events(usage(10,0,10)));revisions.set('child','2')
 assert.equal((await controller.read('/project','t',null,signal)).total,207)
 assert.deepEqual(reads,['a','child','b','child'])
})

test('retry prices follow each actual model and attempt time instead of pricing the aggregate once',()=>{
 const secondTime=Date.parse('2026-10-16T01:00:00Z')
 const items=events().slice(0,4)
 items.push(evt('assistant/attempt',{turn:1,step:1,stream:[{type:'chunk',chunk:{type:'usage',usage:usage()}}]}),evt('llm/retry',{turn:1,step:1}))
 items.push(evt('llm/retry-started',{turn:1,step:1},0,secondTime),evt('request/header',{header:{config:{provider:'deepseek-official',model:'deepseek-v4-pro'}}},0,secondTime+1))
 const second=message(usage(40,20,10));second.message.source.model='deepseek-v4-pro'
 items.push(evt('assistant/message',second,0,secondTime+2),evt('step/end',{},0,secondTime+3),evt('turn/end',{},0,secondTime+4))
 items.forEach((e,i)=>e.seq=i)
 const totals=fold(items).totals
 assert.equal(totals.priced,2);assert.equal(totals.unknownPrice,0)
 assert.equal(totals.uncachedCost,67800);assert.equal(totals.cacheCost,1030);assert.equal(totals.outputCost,51600)
})

test('model and tariff buckets replace provisional samples and partition all totals',async()=>{
 const items=events();items.splice(4,0,evt('assistant/attempt',{turn:1,step:1,stream:[{chunk:{type:'usage',usage:usage(20,10,5)}}]}))
 const off=fold(items.map((e,i)=>({...e,seq:i})))
 assert.equal(off.buckets.length,1);assert.equal(off.buckets[0].period,'off-peak')
 assert.deepEqual(off.buckets[0].totals,off.totals)
 const peakEvents=events().map((e,i)=>({...e,seq:items.length+i,time:Date.parse('2026-10-15T01:00:00Z')+i*100}))
 const combined=fold([...items.map((e,i)=>({...e,seq:i})),...peakEvents])
 assert.deepEqual(combined.buckets.map(b=>b.period),['off-peak','peak'])
 assert.equal(combined.buckets.reduce((n,b)=>n+b.totals.total,0),combined.totals.total)
 assert.equal(combined.buckets[1].totals.uncachedCost,combined.buckets[0].totals.uncachedCost*2)
 // A provisional unknown route is replaced by the final assistant source, not counted twice.
 const late=events();late.splice(3,2,evt('assistant/attempt',{stream:[]}),evt('assistant/message',message()))
 late.forEach((e,i)=>e.seq=i)
 const resolved=fold(late)
 assert.equal(resolved.buckets.length,1);assert.equal(resolved.buckets[0].provider,'deepseek-official')
 assert.deepEqual(resolved.buckets[0].totals,resolved.totals)
 const {controller}=fixture(),all=await controller.read('/project','t',null,new AbortController().signal)
 assert.equal(all.buckets.length,1);assert.equal(all.buckets[0].totals.total,all.total)
 assert.equal(all.buckets[0].totals.requests,all.requests)
})


test('current tariffs start at each model official effective instant, including legacy Flash aliases',()=>{
 const u={input:1000000,cacheRead:1000000,cacheWrite:0,output:1000000}
 for(const model of ['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp']){
   const from=Date.parse('2026-09-10T04:00:00Z')
   assert.equal(priceRequest('deepseek-official',model,from-1,u).kind,'unknown')
   const start=priceRequest('deepseek-official',model,from,u)
   assert.deepEqual(start,{kind:'priced',uncached:150000000,cache:3000000,output:600000000})
 }
 const from=Date.parse('2026-08-16T16:00:00Z')
 assert.equal(priceRequest('deepseek-official','deepseek-v4-pro',from-1,u).kind,'unknown')
 assert.deepEqual(priceRequest('deepseek-official','deepseek-v4-pro',from,u),{kind:'priced',uncached:660000000,cache:22000000,output:1980000000})
 const yesterday=events().map(e=>({...e,time:e.time-86400000}))
 const state=fold(yesterday)
 assert.equal(state.totals.unknownPrice,0);assert.equal(state.totals.priced,1)
 assert.equal(state.buckets[0].period,'off-peak')
 assert.equal(state.totals.uncachedCost+state.totals.cacheCost+state.totals.outputCost,27150)
})
