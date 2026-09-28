import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlPlane } from '../src/control.js';
import { Store } from '../src/store.js';
import type { DiscordAdapter, Snapshot } from '../src/discord.js';

const GuildId='123456789012345678';
const BotRoleId='123456789012345679';
function Fixture() {
  const Directory=mkdtempSync(join(tmpdir(),'discord-control-test-'));
  const Storage=new Store(join(Directory,'control.db'));
  const State:Snapshot={guildId:GuildId,capturedAt:new Date().toISOString(),
    completeness:{channels:'complete',threads:'none',members:'omitted',messages:'omitted'},omissions:['Threads omitted'],
    capabilities:{permissions:['Administrator'],highestRolePosition:10,memberList:false},
    guild:{id:GuildId,name:'Test',owner_id:'123456789012345677'},
    roles:[{id:GuildId,name:'@everyone',permissions:'0',position:0,managed:false},
      {id:BotRoleId,name:'Bot',permissions:'8',position:10,managed:true}],channels:[]};
  let Next=BigInt('123456789012345680');
  const Adapter={
    GetActiveServers:()=>[{id:GuildId,name:'Test',available:true,memberCount:1}],
    Snapshot:async()=>structuredClone(State),
    Post:async (Path:string,Body:Record<string,unknown>)=>{
      const Id=String(Next++);
      if (Path.endsWith('/roles')) State.roles.push({id:Id,name:String(Body.name),permissions:String(Body.permissions),position:1,managed:false});
      else State.channels.push({id:Id,name:String(Body.name),type:Number(Body.type),parent_id:Body.parent_id as string|null,permission_overwrites:Body.permission_overwrites as Snapshot['channels'][number]['permission_overwrites']});
      return {id:Id};
    },
    Patch:async (Path:string,Body:Record<string,unknown>)=>{
      const Id=Path.split('/').at(-1)!;
      if (Path.includes('/roles/')) Object.assign(State.roles.find(Item=>Item.id===Id)!,Body);
      else if (Path.startsWith('/channels/')) Object.assign(State.channels.find(Item=>Item.id===Id)!,Body);
      else Object.assign(State.guild,Body);
      return {id:Id};
    },
    Delete:async (Path:string)=>{
      const Id=Path.split('/').at(-1)!;
      State.roles=State.roles.filter(Item=>Item.id!==Id);
      State.channels=State.channels.filter(Item=>Item.id!==Id);
    }
  };
  return {Directory,Storage,State,Control:new ControlPlane(Adapter as unknown as DiscordAdapter,Storage),Close:()=>{Storage.Close();rmSync(Directory,{recursive:true,force:true});}};
}

test('plans, applies, and verifies a mapped role and channel',async()=>{
  const F=Fixture();
  try {
    const Blueprint={version:1,roles:[{key:'staff',name:'Staff',permissions:['VIEW_CHANNEL']}],
      channels:[{key:'staff-room',name:'staff-room',type:'text',overwrites:[{target:'staff',allow:['VIEW_CHANNEL'],deny:[]}]}]};
    const Plan=await F.Control.PlanServer(GuildId,Blueprint,'RECONCILE','tester');
    assert.equal(Plan.operations.length,2);
    const Applied=await F.Control.ApplyPlan(Plan.id,'tester');
    assert.equal(Applied.status,'succeeded');
    assert.equal((await F.Control.VerifyServer(Plan.id)).verified,true);
    assert.ok(F.Storage.GetMapping(GuildId,'role','staff'));
  } finally {F.Close();}
});

test('refuses name-based adoption and stale destructive plans',async()=>{
  const F=Fixture();
  try {
    F.State.channels.push({id:'123456789012345690',name:'general',type:0});
    await assert.rejects(F.Control.PlanServer(GuildId,{version:1,channels:[{key:'general',name:'general',type:'text'}]},'RECONCILE','tester'),/adopt/);
    const Plan=await F.Control.PlanServer(GuildId,{version:1,channels:[],policy:{pruneChannels:true,pruneRoles:false}},'RECONCILE','tester');
    F.State.channels[0]!.name='changed';
    await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/PLAN_STALE/);
    assert.equal(F.State.channels.length,1);
  } finally {F.Close();}
});

test('does not replay a create after an uncertain response',async()=>{
  const F=Fixture();
  try {
    let Calls=0;
    const Adapter=F.Control.Discord as unknown as {Post:(Path:string,Body:Record<string,unknown>)=>Promise<{id:string}>};
    Adapter.Post=async()=>{Calls++;F.State.roles.push({id:'123456789012345699',name:'Uncertain',permissions:'0',position:1,managed:false});throw new Error('connection lost after send');};
    const Plan=await F.Control.PlanServer(GuildId,{version:1,roles:[{key:'uncertain',name:'Uncertain',permissions:[]}]},'RECONCILE','tester');
    await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/connection lost/);
    assert.equal(F.Storage.GetPlan(Plan.id)?.status,'uncertain');
    await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/uncertain operation/);
    assert.equal(Calls,1);
  } finally {F.Close();}
});

test('focused deletion removes only the exact channel ID',async()=>{
  const F=Fixture();
  try {
    F.State.channels.push({id:'123456789012345690',name:'remove-me',type:0});
    F.State.channels.push({id:'123456789012345691',name:'keep-me',type:0});
    const Plan=await F.Control.PlanResourceMutation(GuildId,'channel','delete','tester',undefined,'123456789012345690');
    assert.equal(Plan.operations.length,1);
    await F.Control.ApplyPlan(Plan.id,'tester');
    assert.deepEqual(F.State.channels.map(Item=>Item.id),['123456789012345691']);
    assert.equal((await F.Control.VerifyServer(Plan.id)).verified,true);
  } finally {F.Close();}
});
