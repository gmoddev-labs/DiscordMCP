import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlPlane } from '../src/control.js';
import { Store } from '../src/store.js';
import { DiscordError, type DiscordAdapter, type Snapshot } from '../src/discord.js';

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
    RequireGuildChannel:async(Guild:string,Id:string)=>{
      if(Guild!==GuildId) throw new Error('Wrong guild');
      const Item=State.channels.find(Value=>Value.id===Id);
      if(!Item) throw new Error('Channel not found');
      return structuredClone(Item);
    },
    Post:async (Path:string,Body:Record<string,unknown>)=>{
      const Id=String(Next++);
      if (Path.endsWith('/roles')) State.roles.push({id:Id,name:String(Body.name),permissions:String(Body.permissions),position:1,managed:false,
        hoist:Boolean(Body.hoist),mentionable:Boolean(Body.mentionable),color:Number(Body.color)});
      else State.channels.push({id:Id,name:String(Body.name),type:Number(Body.type),parent_id:Body.parent_id as string|null,
        topic:Body.topic as string|null|undefined,nsfw:Body.nsfw as boolean|undefined,
        permission_overwrites:Body.permission_overwrites as Snapshot['channels'][number]['permission_overwrites']});
      return {id:Id};
    },
    Get:async (Path:string)=>{
      const Id=Path.split('/').at(-1)!;
      if (Path.startsWith('/channels/')) return structuredClone(State.channels.find(Item=>Item.id===Id));
      if (Path.includes('/members/')) return {user:{id:Id,username:'member'},roles:[]};
      throw new Error(`Unexpected GET ${Path}`);
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
  return {Directory,Storage,State,Adapter,Control:new ControlPlane(Adapter as unknown as DiscordAdapter,Storage),Close:()=>{Storage.Close();rmSync(Directory,{recursive:true,force:true});}};
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

test('unchanged blueprint produces no operations',async()=>{
  const F=Fixture();
  try {
    const RoleId='123456789012345690';
    const ChannelId='123456789012345691';
    F.State.roles.push({id:RoleId,name:'Staff',permissions:'1024',position:1,managed:false,hoist:true,mentionable:false,color:123});
    F.State.channels.push({id:ChannelId,name:'staff',type:0,parent_id:null,topic:'Private',nsfw:false,
      permission_overwrites:[{id:RoleId,type:0,allow:'1024',deny:'0'}]});
    F.Storage.SetMapping(GuildId,'role','staff',RoleId);
    F.Storage.SetMapping(GuildId,'channel','staff',ChannelId);
    const Plan=await F.Control.PlanServer(GuildId,{version:1,
      roles:[{key:'staff',name:'Staff',permissions:['VIEW_CHANNEL'],hoist:true,color:123}],
      channels:[{key:'staff',name:'staff',type:'text',topic:'Private',overwrites:[{target:'staff',allow:['VIEW_CHANNEL'],deny:[]}]}]},'RECONCILE','tester');
    assert.deepEqual(Plan.operations,[]);
  } finally {F.Close();}
});

test('new channel and role invalidate pruning plans before mutation',async()=>{
  for (const Kind of ['channel','role'] as const) {
    const F=Fixture();
    try {
      const Plan=await F.Control.PlanServer(GuildId,{version:1,policy:{pruneChannels:Kind==='channel',pruneRoles:Kind==='role'}},'RECONCILE','tester');
      if (Kind==='channel') F.State.channels.push({id:'123456789012345690',name:'new',type:0});
      else F.State.roles.push({id:'123456789012345690',name:'New',permissions:'0',position:1,managed:false});
      await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/PLAN_STALE/);
      assert.equal(F.Storage.GetPlan(Plan.id)?.status,'planned');
    } finally {F.Close();}
  }
});

test('message activity does not stale a structural plan',async()=>{
  const F=Fixture();
  try {
    const ChannelId='123456789012345690';
    F.State.channels.push({id:ChannelId,name:'general',type:0,last_message_id:'123456789012345691'} as Snapshot['channels'][number]);
    const Plan=await F.Control.PlanResourceMutation(GuildId,'channel','delete','tester',undefined,ChannelId);
    (F.State.channels[0] as Snapshot['channels'][number]&{last_message_id:string}).last_message_id='123456789012345692';
    await F.Control.ApplyPlan(Plan.id,'tester');
    assert.equal(F.State.channels.length,0);
  } finally {F.Close();}
});

test('reconciliation removes extra overwrites and clears an empty desired set',async()=>{
  const F=Fixture();
  try {
    const ChannelId='123456789012345690';
    F.State.channels.push({id:ChannelId,name:'private',type:0,parent_id:null,
      permission_overwrites:[{id:'123456789012345691',type:0,allow:'1024',deny:'0'}]});
    F.Storage.SetMapping(GuildId,'channel','private',ChannelId);
    const Blueprint={version:1,channels:[{key:'private',name:'private',type:'text',overwrites:[]}]};
    const Plan=await F.Control.PlanServer(GuildId,Blueprint,'RECONCILE','tester');
    assert.equal(Plan.operations.length,1);
    await F.Control.ApplyPlan(Plan.id,'tester');
    assert.deepEqual(F.State.channels[0]?.permission_overwrites,[]);
    F.State.channels[0]!.permission_overwrites=[{id:'123456789012345691',type:0,allow:'1024',deny:'0'}];
    assert.equal((await F.Control.VerifyServer(Plan.id)).verified,false);
  } finally {F.Close();}
});

test('verification checks declared role and channel fields',async()=>{
  const F=Fixture();
  try {
    const Plan=await F.Control.PlanServer(GuildId,{version:1,
      roles:[{key:'staff',name:'Staff',permissions:[],hoist:true,mentionable:true,color:345}],
      channels:[{key:'general',name:'general',type:'text',topic:'A topic',nsfw:true}]},'RECONCILE','tester');
    await F.Control.ApplyPlan(Plan.id,'tester');
    F.State.roles.find(Item=>Item.name==='Staff')!.hoist=false;
    assert.equal((await F.Control.VerifyServer(Plan.id)).verified,false);
    F.State.roles.find(Item=>Item.name==='Staff')!.hoist=true;
    F.State.channels.find(Item=>Item.name==='general')!.topic='Changed';
    assert.equal((await F.Control.VerifyServer(Plan.id)).verified,false);
    F.State.channels.find(Item=>Item.name==='general')!.topic='A topic';
    F.State.roles.find(Item=>Item.name==='Staff')!.mentionable=false;
    assert.equal((await F.Control.VerifyServer(Plan.id)).verified,false);
    F.State.roles.find(Item=>Item.name==='Staff')!.mentionable=true;
    F.State.roles.find(Item=>Item.name==='Staff')!.color=0;
    assert.equal((await F.Control.VerifyServer(Plan.id)).verified,false);
    F.State.roles.find(Item=>Item.name==='Staff')!.color=345;
    F.State.channels.find(Item=>Item.name==='general')!.nsfw=false;
    assert.equal((await F.Control.VerifyServer(Plan.id)).verified,false);
  } finally {F.Close();}
});

test('specified overwrite set replaces extra grants',async()=>{
  const F=Fixture();
  try {
    const ChannelId='123456789012345690';
    F.State.channels.push({id:ChannelId,name:'staff',type:0,parent_id:null,
      permission_overwrites:[{id:'123456789012345691',type:0,allow:'1024',deny:'0'}]});
    F.Storage.SetMapping(GuildId,'channel','staff',ChannelId);
    const Plan=await F.Control.PlanServer(GuildId,{version:1,channels:[{key:'staff',name:'staff',type:'text',
      overwrites:[{target:'@everyone',allow:[],deny:['VIEW_CHANNEL']}]}]},'RECONCILE','tester');
    await F.Control.ApplyPlan(Plan.id,'tester');
    assert.deepEqual(F.State.channels[0]?.permission_overwrites,[{id:GuildId,type:0,allow:'0',deny:'1024'}]);
  } finally {F.Close();}
});

test('mapped channel type mismatch is rejected before execution',async()=>{
  const F=Fixture();
  try {
    const Id='123456789012345690';
    F.State.channels.push({id:Id,name:'general',type:2});
    F.Storage.SetMapping(GuildId,'channel','general',Id);
    await assert.rejects(F.Control.PlanServer(GuildId,{version:1,channels:[{key:'general',name:'general',type:'text'}]},'RECONCILE','tester'),/incompatible type/);
  } finally {F.Close();}
});

test('failed plan is terminal',async()=>{
  const F=Fixture();
  try {
    let Calls=0;
    F.Adapter.Post=async()=>{Calls++;throw new DiscordError(403,'MISSING_PERMISSIONS','denied');};
    const Plan=await F.Control.PlanServer(GuildId,{version:1,roles:[{key:'staff',name:'Staff',permissions:[]}]},'RECONCILE','tester');
    await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/denied/);
    await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/terminal/);
    assert.equal(Calls,1);
  } finally {F.Close();}
});

test('creation name absence is checked again at apply time',async()=>{
  const F=Fixture();
  try {
    const Plan=await F.Control.PlanServer(GuildId,{version:1,channels:[{key:'new',name:'new',type:'text'}]},'RECONCILE','tester');
    F.State.channels.push({id:'123456789012345690',name:'new',type:0});
    await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/PLAN_STALE/);
  } finally {F.Close();}
});

test('community channel deletion is rejected and replace deletes children before categories',async()=>{
  const F=Fixture();
  try {
    const Category='123456789012345690';
    const Child='123456789012345691';
    F.State.channels.push({id:Category,name:'Category',type:4});
    F.State.channels.push({id:Child,name:'child',type:0,parent_id:Category});
    F.State.guild.rules_channel_id=Child;
    await assert.rejects(F.Control.PlanResourceMutation(GuildId,'channel','delete','tester',undefined,Child),/Community/);
    F.State.guild.rules_channel_id=null;
    const Plan=await F.Control.PlanServer(GuildId,{version:1},'REPLACE','tester');
    assert.deepEqual(Plan.operations.filter(Item=>Item.action==='delete').map(Item=>Item.targetId),[Child,Category]);
  } finally {F.Close();}
});

test('direct actions serialize and block plans until completion',async()=>{
  const F=Fixture();
  try {
    const RoleId='123456789012345690';
    const UserId='123456789012345691';
    F.State.roles.push({id:RoleId,name:'Member',permissions:'0',position:1,managed:false});
    let Active=0;
    let Peak=0;
    let ReleaseFirst!:()=>void;
    const Hold=new Promise<void>(Resolve=>{ReleaseFirst=Resolve;});
    let Calls=0;
    (F.Adapter as typeof F.Adapter&{RequestPut:(Path:string,Reason:string)=>Promise<void>}).RequestPut=async()=>{
      Calls++;Active++;Peak=Math.max(Peak,Active);
      if (Calls===1) await Hold;
      Active--;
    };
    const First=F.Control.AddMemberRole(GuildId,UserId,RoleId,'tester');
    await new Promise<void>(Resolve=>setTimeout(Resolve,20));
    const Second=F.Control.AddMemberRole(GuildId,UserId,RoleId,'tester');
    const Plan=await F.Control.PlanServer(GuildId,{version:1},'RECONCILE','tester');
    const Applying=F.Control.ApplyPlan(Plan.id,'tester');
    assert.equal(F.Storage.GetPlan(Plan.id)?.status,'planned');
    ReleaseFirst();
    await Promise.all([First,Second,Applying]);
    assert.equal(Peak,1);
    assert.equal(Calls,2);
  } finally {F.Close();}
});

test('uncertain direct action blocks mutation until explicitly resolved',async()=>{
  const F=Fixture();
  try {
    const RoleId='123456789012345690';
    const UserId='123456789012345691';
    F.State.roles.push({id:RoleId,name:'Member',permissions:'0',position:1,managed:false});
    (F.Adapter as typeof F.Adapter&{RequestPut:()=>Promise<void>}).RequestPut=async()=>{throw new Error('network lost');};
    await assert.rejects(F.Control.AddMemberRole(GuildId,UserId,RoleId,'tester'),/actionId=/);
    const Actions=F.Control.GetUncertainActions(GuildId) as {id:string}[];
    assert.equal(Actions.length,1);
    const Plan=await F.Control.PlanServer(GuildId,{version:1},'RECONCILE','tester');
    await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/uncertain mutation/);
    await F.Control.ResolveUncertainAction(Actions[0]!.id,'tester');
    await F.Control.ApplyPlan(Plan.id,'tester');
  } finally {F.Close();}
});

test('member moderation enforces owner and hierarchy before Discord mutation',async()=>{
  const F=Fixture();
  try {
    await assert.rejects(F.Control.KickMember(GuildId,F.State.guild.owner_id,'tester'),/owner/);
    assert.deepEqual(F.Control.GetUncertainActions(GuildId),[]);
    const RoleId='123456789012345690';
    const UserId='123456789012345691';
    F.State.roles.push({id:RoleId,name:'High',permissions:'0',position:10,managed:false});
    F.Adapter.Get=async()=>({user:{id:UserId,username:'high'},roles:[RoleId]});
    await assert.rejects(F.Control.BanMember(GuildId,UserId,'tester'),/hierarchy/);
  } finally {F.Close();}
});

test('concurrent calls to the same plan execute a create only once',async()=>{
  const F=Fixture();
  try {
    const Plan=await F.Control.PlanServer(GuildId,{version:1,roles:[{key:'one',name:'One',permissions:[]}]},'RECONCILE','tester');
    const Original=F.Adapter.Post;
    let Calls=0;
    F.Adapter.Post=async (Path,Body)=>{
      Calls++;
      await new Promise<void>(Resolve=>setTimeout(Resolve,20));
      return Original(Path,Body);
    };
    const Results=await Promise.all([F.Control.ApplyPlan(Plan.id,'tester'),F.Control.ApplyPlan(Plan.id,'tester')]);
    assert.deepEqual(Results.map(Item=>Item.status),['succeeded','succeeded']);
    assert.equal(Calls,1);
  } finally {F.Close();}
});

test('mapping order is deterministic and interrupted plan can be abandoned',async()=>{
  const F=Fixture();
  try {
    F.Storage.SetMapping(GuildId,'role','z','123456789012345690');
    F.Storage.SetMapping(GuildId,'role','a','123456789012345691');
    assert.deepEqual(Object.keys(F.Storage.GetMappings(GuildId,'role')),['a','z']);
    const Plan=await F.Control.PlanServer(GuildId,{version:1},'RECONCILE','tester');
    Plan.status='running';F.Storage.SavePlan(Plan);
    await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/Interrupted running/);
    await F.Control.AbandonPlan(Plan.id,'tester');
    assert.equal(F.Storage.GetPlan(Plan.id)?.status,'abandoned');
  } finally {F.Close();}
});

test('v1 blueprint reconciles optional channel and guild settings through semantic channel keys',async()=>{
  const F=Fixture();
  try {
    const ChannelId='123456789012345692';
    F.State.channels.push({id:ChannelId,guild_id:GuildId,name:'general',type:0,rate_limit_per_user:0});
    await F.Control.AdoptResource(GuildId,'channel','general',ChannelId);
    const Blueprint={version:1,channels:[{key:'general',name:'general',type:'text',rateLimitPerUser:10}],
      guild:{description:'A shared project server',systemChannel:'general'}};
    const Plan=await F.Control.PlanServer(GuildId,Blueprint,'RECONCILE','tester');
    assert.equal(Plan.operations.filter(Item=>Item.resource==='channel').length,1);
    assert.equal(Plan.operations.filter(Item=>Item.resource==='guild').length,1);
    const Applied=await F.Control.ApplyPlan(Plan.id,'tester');
    assert.equal(Applied.status,'succeeded');
    assert.equal(F.State.channels[0]?.rate_limit_per_user,10);
    assert.equal(F.State.guild.system_channel_id,ChannelId);
    assert.equal((await F.Control.VerifyServer(Plan.id)).verified,true);
  } finally {F.Close();}
});

test('forum tag updates require exact existing tag IDs and stale optional state blocks apply',async()=>{
  const F=Fixture();
  try {
    const ChannelId='123456789012345693',TagId='123456789012345694';
    F.State.channels.push({id:ChannelId,guild_id:GuildId,name:'forum',type:15,
      available_tags:[{id:TagId,name:'News',moderated:false}]});
    await F.Control.AdoptResource(GuildId,'channel','forum',ChannelId);
    await assert.rejects(F.Control.PlanServer(GuildId,{version:1,channels:[{key:'forum',name:'forum',type:'forum',
      forum:{availableTags:[{name:'Updates'}]}}]},'RECONCILE','tester'),/exact IDs/);
    const Plan=await F.Control.PlanServer(GuildId,{version:1,channels:[{key:'forum',name:'forum',type:'forum',
      forum:{availableTags:[{id:TagId,name:'Updates'}]}}]},'RECONCILE','tester');
    F.State.channels[0]!.available_tags![0]!.name='Changed elsewhere';
    await assert.rejects(F.Control.ApplyPlan(Plan.id,'tester'),/PLAN_STALE/);
  } finally {F.Close();}
});

test('forum tag and role emoji reconcile using exact identities',async()=>{
  const F=Fixture();
  try {
    const ChannelId='123456789012345693',TagId='123456789012345694',RoleId='123456789012345695';
    F.State.channels.push({id:ChannelId,guild_id:GuildId,name:'forum',type:15,
      available_tags:[{id:TagId,name:'News',moderated:false}]});
    F.State.roles.push({id:RoleId,name:'Member',permissions:'0',position:1,managed:false});
    await F.Control.AdoptResource(GuildId,'channel','forum',ChannelId);
    await F.Control.AdoptResource(GuildId,'role','member',RoleId);
    const Plan=await F.Control.PlanServer(GuildId,{version:1,
      roles:[{key:'member',name:'Member',permissions:[],unicodeEmoji:'🔔'}],
      channels:[{key:'forum',name:'forum',type:'forum',forum:{availableTags:[{id:TagId,name:'Updates'}]}}]},
      'RECONCILE','tester');
    const Applied=await F.Control.ApplyPlan(Plan.id,'tester');
    assert.equal(Applied.status,'succeeded');
    assert.equal(F.State.roles.find(Item=>Item.id===RoleId)?.unicode_emoji,'🔔');
    assert.equal(F.State.channels.find(Item=>Item.id===ChannelId)?.available_tags?.[0]?.name,'Updates');
  } finally {F.Close();}
});
