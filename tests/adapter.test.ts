import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordAdapter, DiscordError, type Snapshot } from '../src/discord.js';

const GuildId='123456789012345678';
const ParentId='123456789012345679';
const ThreadA='123456789012345680';
const ThreadB='123456789012345681';
const SnapshotValue:Snapshot={guildId:GuildId,capturedAt:new Date().toISOString(),
  completeness:{channels:'accessible_only',threads:'none',members:'omitted',messages:'omitted'},omissions:['Threads omitted'],
  capabilities:{permissions:['ReadMessageHistory'],highestRolePosition:1,memberList:false},
  guild:{id:GuildId,name:'Test',owner_id:'123456789012345677'},roles:[],channels:[{id:ParentId,name:'parent',type:0}]};

test('allAccessible pages joined archived private threads by snowflake',async()=>{
  const Paths:string[]=[];
  const Adapter=new DiscordAdapter('unused',async (Input)=>{
    const Path=new URL(String(Input)).pathname+new URL(String(Input)).search;
    Paths.push(Path);
    if (Path.endsWith('/threads/active')) return new Response(JSON.stringify({threads:[]}),{status:200});
    if (Path.includes('/archived/public')) return new Response(JSON.stringify({threads:[],has_more:false}),{status:200});
    if (Path.includes('/users/@me/threads/archived/private')) {
      const First=!Path.includes('before=');
      return new Response(JSON.stringify({threads:[{id:First?ThreadA:ThreadB,name:'private',type:12}],has_more:First}),{status:200});
    }
    throw new Error(`Unexpected path ${Path}`);
  });
  (Adapter as unknown as {Snapshot:()=>Promise<Snapshot>}).Snapshot=async()=>structuredClone(SnapshotValue);
  const Result=await Adapter.GetAllChannels(GuildId,'allAccessible');
  assert.equal(Result.completeness.threads,'all_accessible');
  assert.deepEqual(Result.threads.map(Item=>Item.id),[ThreadA,ThreadB]);
  assert.ok(Paths.some(Path=>Path.includes(`before=${ThreadA}`)));
  assert.ok(!Paths.some(Path=>Path.includes('/threads/archived/private')&&!Path.includes('/users/@me/')));
});

test('rate-limit buckets include Discord bucket ID and major resource ID',async()=>{
  const Adapter=new DiscordAdapter('unused',async()=>new Response(JSON.stringify({id:ParentId}),{status:200,
    headers:{'X-RateLimit-Bucket':'bucket-abc','X-RateLimit-Remaining':'0','X-RateLimit-Reset-After':'0.5'}}));
  await Adapter.Get(`/channels/${ParentId}`);
  const Other='123456789012345688';
  await Adapter.Get(`/channels/${Other}`);
  const Internals=Adapter as unknown as {RouteBuckets:Map<string,string>;BucketUntil:Map<string,number>};
  assert.equal(Internals.RouteBuckets.get('GET /channels/:id'),'bucket-abc');
  assert.ok(Internals.BucketUntil.has(`bucket-abc|channels:${ParentId}`));
  assert.ok(Internals.BucketUntil.has(`bucket-abc|channels:${Other}`));
});

test('429 retries mutations, network exceptions do not',async()=>{
  let Calls=0;
  const Adapter=new DiscordAdapter('unused',async()=>{
    Calls++;
    if (Calls===1) return new Response(JSON.stringify({retry_after:0.001,global:false}),{status:429,headers:{'X-RateLimit-Bucket':'bucket-a'}});
    return new Response(JSON.stringify({id:ParentId}),{status:200});
  });
  assert.deepEqual(await Adapter.Post(`/guilds/${GuildId}/roles`,{name:'x'},'test'),{id:ParentId});
  assert.equal(Calls,2);
  let NetworkCalls=0;
  const Failing=new DiscordAdapter('unused',async()=>{NetworkCalls++;throw new Error('network lost');});
  await assert.rejects(Failing.Post(`/guilds/${GuildId}/roles`,{name:'x'},'test'),(Cause:unknown)=>Cause instanceof DiscordError&&Cause.Code==='NETWORK');
  assert.equal(NetworkCalls,1);
});
