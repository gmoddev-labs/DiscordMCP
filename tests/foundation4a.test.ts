import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiscordError,type DiscordAdapter,type Snapshot} from '../src/discord.js';
import {ControlPlane} from '../src/control.js';
import {Store} from '../src/store.js';
import {Dispatch} from '../src/interface.js';

const GuildId='123456789012345678',RuleId='123456789012345679',ChannelId='123456789012345680';
const ForeignId='123456789012345681',RoleId='123456789012345682';
const Actor={id:'local-mcp:foundation4a',kind:'local-mcp' as const};
function Fixture() {
  const Directory=mkdtempSync(join(tmpdir(),'discord-f4a-'));
  const StoreValue=new Store(join(Directory,'control.db'));
  const Requests:{method:string;path:string;body?:any}[]=[];
  const Permissions=['ManageGuild','ModerateMembers'];
  const Rules:any[]=[];
  let Failure:unknown;
  const Adapter={
    RequireGuild:(Id:string)=>{if(Id!==GuildId) throw new Error('Wrong guild');},
    RequireGuildChannel:async(Id:string,Channel:string)=>{
      if(Id!==GuildId||Channel!==ChannelId) throw new Error('Channel does not belong to the exact requested guild');
      return {id:ChannelId,guild_id:GuildId,type:0};
    },
    Snapshot:async()=>({guildId:GuildId,guild:{id:GuildId,features:['COMMUNITY']},
      roles:[{id:GuildId,name:'@everyone',permissions:'0',position:0,managed:false},{id:RoleId,name:'role',permissions:'0',position:1,managed:false}],
      channels:[{id:ChannelId,guild_id:GuildId,name:'text',type:0}],capabilities:{permissions:Permissions,highestRolePosition:10,memberList:false},
      completeness:{channels:'complete',threads:'none',members:'omitted',messages:'omitted'},omissions:[],capturedAt:new Date().toISOString()}) as Snapshot,
    Get:async(Path:string)=>{
      Requests.push({method:'GET',path:Path});
      if(Path===`/guilds/${GuildId}/auto-moderation/rules`) return structuredClone(Rules);
      if(Path.endsWith(`/${RuleId}`)) return structuredClone(Rules.find(Item=>Item.id===RuleId));
      throw new Error(`Unexpected GET ${Path}`);
    },
    Post:async(Path:string,Body:any)=>{
      Requests.push({method:'POST',path:Path,body:Body});if(Failure) throw Failure;
      const Value={id:RuleId,guild_id:GuildId,name:Body.name,trigger_type:Body.trigger_type,event_type:Body.event_type,
        trigger_metadata:Body.trigger_metadata,actions:Body.actions,enabled:Body.enabled,
        exempt_roles:Body.exempt_roles??[],exempt_channels:Body.exempt_channels??[]};
      Rules.push(Value);return structuredClone(Value);
    },
    Patch:async(Path:string,Body:any)=>{
      Requests.push({method:'PATCH',path:Path,body:Body});if(Failure) throw Failure;
      Object.assign(Rules[0],Body);return structuredClone(Rules[0]);
    },
    Delete:async(Path:string)=>{Requests.push({method:'DELETE',path:Path});if(Failure) throw Failure;Rules.splice(0,1);}
  };
  return {Control:new ControlPlane(Adapter as unknown as DiscordAdapter,StoreValue),Rules,Permissions,Requests,
    SetFailure:(Value:unknown)=>{Failure=Value;},Close:()=>{StoreValue.Close();rmSync(Directory,{recursive:true,force:true});}};
}
test('AutoMod typed creation, exact references, limits, and direct-action uncertainty',async()=>{
  const F=Fixture();
  try {
    const Base={guildId:GuildId,name:'filter',trigger:{kind:'keyword',keywordFilter:['spam']},actions:[{kind:'blockMessage'}]};
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{...Base,exemptChannelIds:[ForeignId]},Actor),/exact requested guild/);
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{...Base,trigger:{kind:'spam'},actions:[{kind:'timeout',durationSeconds:60}]},Actor),/Timeout/);
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{...Base,actions:[{kind:'sendAlert',channelId:ForeignId}]},Actor),/exact requested guild/);
    const Created=await Dispatch(F.Control,'CreateAutoModRule',Base,Actor) as {rule:{id:string;enabled:boolean}};
    assert.equal(Created.rule.id,RuleId);assert.equal(Created.rule.enabled,false);
    assert.equal(F.Requests.find(Item=>Item.method==='POST')?.body.trigger_type,1);
    await assert.rejects(Dispatch(F.Control,'ModifyAutoModRule',{guildId:GuildId,ruleId:RuleId,changes:{trigger:{kind:'spam'}}},Actor),/trigger kind/);
    await Dispatch(F.Control,'ModifyAutoModRule',{guildId:GuildId,ruleId:RuleId,changes:{enabled:true}},Actor);
    assert.equal((await Dispatch(F.Control,'GetAutoModRule',{guildId:GuildId,ruleId:RuleId},Actor) as any).rule.enabled,true);
    F.SetFailure(new DiscordError(0,'NETWORK','disconnected'));
    await assert.rejects(Dispatch(F.Control,'DeleteAutoModRule',{guildId:GuildId,ruleId:RuleId},Actor),/state=uncertain/);
    await assert.rejects(Dispatch(F.Control,'ModifyAutoModRule',{guildId:GuildId,ruleId:RuleId,changes:{enabled:false}},Actor),/uncertain mutation/);
  } finally {F.Close();}
});
test('AutoMod timeout needs ModerateMembers and trigger count limits apply before POST',async()=>{
  const F=Fixture();
  try {
    F.Permissions.splice(F.Permissions.indexOf('ModerateMembers'),1);
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{guildId:GuildId,name:'timeout',
      trigger:{kind:'keyword',keywordFilter:['spam']},actions:[{kind:'timeout',durationSeconds:60}]},Actor),/ModerateMembers/);
    F.Rules.push({id:RuleId,guild_id:GuildId,name:'spam',trigger_type:3,event_type:1,actions:[{type:1}],enabled:false});
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{guildId:GuildId,name:'spam',trigger:{kind:'spam'},
      actions:[{kind:'blockMessage'}]},Actor),/limit reached/);
    assert.equal(F.Requests.filter(Item=>Item.method==='POST').length,0);
  } finally {F.Close();}
});
