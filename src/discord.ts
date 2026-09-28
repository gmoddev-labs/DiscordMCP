import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { setTimeout as Sleep } from 'node:timers/promises';
import { Snowflake } from './types.js';

export type DiscordRole = {id:string; name:string; permissions:string; position:number; managed:boolean; hoist?:boolean; mentionable?:boolean; color?:number};
export type DiscordChannel = {id:string; name:string; type:number; parent_id?:string|null; position?:number; topic?:string|null; nsfw?:boolean; permission_overwrites?:{id:string;type:number;allow:string;deny:string}[];thread_metadata?:{archive_timestamp?:string}};
export type DiscordGuild = {id:string; name:string; owner_id:string; rules_channel_id?:string|null; public_updates_channel_id?:string|null; features?:string[]};
export type DiscordMember = {user:{id:string;username:string;bot?:boolean}; roles:string[]; nick?:string|null};
export type Snapshot = {
  guildId:string; capturedAt:string; completeness:{channels:'complete'|'accessible_only';threads:'none';members:'omitted'|'complete'|'partial';messages:'omitted'};
  omissions:string[]; capabilities:{permissions:string[]; highestRolePosition:number; memberList:boolean};
  guild:DiscordGuild; roles:DiscordRole[]; channels:DiscordChannel[]; members?:DiscordMember[];
};

export class DiscordError extends Error {
  constructor(readonly Status: number, readonly Code: string, Message: string) { super(Message); }
}

export class DiscordAdapter {
  private readonly Client: Client;
  private readonly Token: string;
  private GlobalUntil = 0;
  private readonly BucketUntil = new Map<string,number>();
  private readonly RouteBuckets = new Map<string,string>();
  constructor(Token: string,private readonly FetchImpl:typeof fetch=fetch) {
    this.Token = Token;
    this.Client = new Client({intents:[GatewayIntentBits.Guilds]});
  }
  async Start(): Promise<void> { await this.Client.login(this.Token); }
  Stop(): void { this.Client.destroy(); }
  GetActiveServers(): {id:string;name:string;available:boolean;memberCount:number}[] {
    return this.Client.guilds.cache.map(Guild => ({id:Guild.id,name:Guild.name,available:Guild.available,memberCount:Guild.memberCount}));
  }
  private async Request<T>(Method:string, Path:string, Body?:unknown, Reason?:string): Promise<T> {
    const Route = `${Method} ${Path.split('?')[0]?.replace(/\d{17,20}/g, ':id')}`;
    const MajorMatch=Path.match(/^\/(guilds|channels|webhooks)\/(\d{17,20})(?:\/|\?|$)/);
    const Major=MajorMatch?`${MajorMatch[1]}:${MajorMatch[2]}`:'global';
    for (let Attempt=0; Attempt<6; Attempt++) {
      const BucketName=this.RouteBuckets.get(Route)??`route:${Route}`;
      const BucketKey=`${BucketName}|${Major}`;
      const Until = Math.max(this.GlobalUntil, this.BucketUntil.get(BucketKey) ?? 0);
      if (Until>Date.now()) await Sleep(Until-Date.now());
      const Headers: Record<string,string> = {Authorization:`Bot ${this.Token}`};
      if (Body !== undefined) Headers['Content-Type']='application/json';
      if (Reason) Headers['X-Audit-Log-Reason']=encodeURIComponent(Reason.slice(0,512));
      let Response: Response;
      try { Response = await this.FetchImpl(`https://discord.com/api/v10${Path}`, {method:Method,headers:Headers,body:Body===undefined?undefined:JSON.stringify(Body)}); }
      catch (Cause) {
        // A timed-out mutation may have succeeded. Only reads can be replayed safely.
        if (Method!=='GET'||Attempt===5) throw new DiscordError(0,'NETWORK',String(Cause));
        await Sleep(250*(Attempt+1)); continue;
      }
      const ObservedBucket=Response.headers.get('x-ratelimit-bucket');
      if (ObservedBucket) this.RouteBuckets.set(Route,ObservedBucket);
      const ObservedKey=`${ObservedBucket??BucketName}|${Major}`;
      if (Response.status===429) {
        const Result = await Response.json() as {retry_after?:number;global?:boolean};
        const Delay = Math.max(100,Math.ceil((Result.retry_after??1)*1000));
        if (Result.global) this.GlobalUntil=Date.now()+Delay;
        else this.BucketUntil.set(ObservedKey,Date.now()+Delay);
        continue;
      }
      const Remaining = Response.headers.get('x-ratelimit-remaining');
      const ResetAfter = Number(Response.headers.get('x-ratelimit-reset-after') ?? 0);
      if (Remaining==='0' && ResetAfter>0) this.BucketUntil.set(ObservedKey,Date.now()+Math.ceil(ResetAfter*1000));
      if (!Response.ok) {
        const Result = await Response.json().catch(() => ({})) as {code?:number;message?:string};
        throw new DiscordError(Response.status,String(Result.code??'HTTP_ERROR'),Result.message??`Discord HTTP ${Response.status}`);
      }
      return Response.status===204 ? undefined as T : await Response.json() as T;
    }
    throw new DiscordError(429,'RATE_LIMIT','Discord rate limit retry budget exhausted');
  }
  Get<T>(Path:string):Promise<T> {return this.Request<T>('GET',Path);}
  Post<T>(Path:string,Body:unknown,Reason:string):Promise<T> {return this.Request<T>('POST',Path,Body,Reason);}
  Patch<T>(Path:string,Body:unknown,Reason:string):Promise<T> {return this.Request<T>('PATCH',Path,Body,Reason);}
  Delete(Path:string,Reason:string):Promise<void> {return this.Request<void>('DELETE',Path,undefined,Reason);}
  RequestPut(Path:string,Reason:string,Body?:unknown):Promise<void> {return this.Request<void>('PUT',Path,Body,Reason);}
  async Snapshot(GuildId:string, IncludeMembers=false):Promise<Snapshot> {
    Snowflake.parse(GuildId);
    if (!this.Client.guilds.cache.has(GuildId)) throw new Error('Bot is not in the exact requested guild');
    const BotId=this.Client.user?.id;
    if (!BotId) throw new Error('Discord gateway has no authenticated bot user');
    const [Guild,Roles,Channels,Me] = await Promise.all([
      this.Get<DiscordGuild>(`/guilds/${GuildId}`), this.Get<DiscordRole[]>(`/guilds/${GuildId}/roles`),
      this.Get<DiscordChannel[]>(`/guilds/${GuildId}/channels`), this.Get<DiscordMember>(`/guilds/${GuildId}/members/${BotId}`)
    ]);
    const OwnRoles = Roles.filter(Role=>Me.roles.includes(Role.id));
    const Highest = Math.max(0,...OwnRoles.map(Role=>Role.position));
    const Permissions = BigInt(Roles.find(Role=>Role.id===GuildId)?.permissions??'0') | OwnRoles.reduce((Bits,Role)=>Bits|BigInt(Role.permissions),0n);
    const Names = Object.entries(PermissionFlagsBits).filter(([,Bit])=>(Permissions & BigInt(Bit))===BigInt(Bit)).map(([Name])=>Name);
    const Administrator = (Permissions & PermissionFlagsBits.Administrator)!==0n;
    const SnapshotValue:Snapshot = {
      guildId:GuildId,capturedAt:new Date().toISOString(),
      completeness:{channels:Administrator?'complete':'accessible_only',threads:'none',members:'omitted',messages:'omitted'},
      omissions:Administrator?['Threads omitted']:['Channel visibility cannot be proven complete','Threads omitted'],
      capabilities:{permissions:Names,highestRolePosition:Highest,memberList:false},guild:Guild,roles:Roles,channels:Channels
    };
    if (IncludeMembers) {
      try { SnapshotValue.members=await this.GetAllMembers(GuildId); SnapshotValue.completeness.members='complete'; SnapshotValue.capabilities.memberList=true; }
      catch (Cause) { SnapshotValue.completeness.members='partial'; SnapshotValue.omissions.push(`Members unavailable: ${Cause instanceof Error?Cause.message:String(Cause)}`); }
    }
    return SnapshotValue;
  }
  async GetAllMembers(GuildId:string):Promise<DiscordMember[]> {
    Snowflake.parse(GuildId);
    const Members:DiscordMember[]=[];
    let After='0';
    while (true) {
      const Page=await this.Get<DiscordMember[]>(`/guilds/${GuildId}/members?limit=1000&after=${After}`);
      Members.push(...Page);
      if (Page.length<1000) break;
      const Last=Page.at(-1)?.user.id;
      if (!Last || Last===After) throw new Error('Member pagination did not advance');
      After=Last;
    }
    return Members;
  }
  async GetAllChannels(GuildId:string,ThreadScope:'none'|'active'|'allAccessible'='none'):
    Promise<{guildId:string;channels:DiscordChannel[];threads:DiscordChannel[];completeness:{channels:'complete'|'accessible_only';threads:'none'|'active'|'all_accessible'|'partial'};omissions:string[]}> {
    const SnapshotValue=await this.Snapshot(GuildId);
    const Threads=new Map<string,DiscordChannel>();
    const Omissions=[...SnapshotValue.omissions.filter(Item=>Item!=='Threads omitted')];
    let Completeness:'none'|'active'|'all_accessible'|'partial'='none';
    if (ThreadScope!=='none') {
      try {
        const Active=await this.Get<{threads:DiscordChannel[]}>(`/guilds/${GuildId}/threads/active`);
        for (const Item of Active.threads) Threads.set(Item.id,Item);
        Completeness='active';
      } catch (Cause) {
        Omissions.push(`Active threads unavailable: ${Cause instanceof Error?Cause.message:String(Cause)}`);
        Completeness='partial';
      }
    }
    if (ThreadScope==='allAccessible') {
      if (Completeness!=='partial') Completeness='all_accessible';
      const Parents=SnapshotValue.channels.filter(Item=>[0,5,15,16].includes(Item.type));
      for (const Parent of Parents) {
        for (const Kind of Parent.type===0?['public','private']:['public']) {
          let JoinedPrivate=Kind==='private'&&!SnapshotValue.capabilities.permissions.some(Name=>Name==='Administrator'||Name==='ManageThreads');
          let Before:string|undefined;
          while (true) {
            try {
              const Query=Before?`?limit=100&before=${encodeURIComponent(Before)}`:'?limit=100';
              const Base=JoinedPrivate?`/channels/${Parent.id}/users/@me/threads/archived/private`:`/channels/${Parent.id}/threads/archived/${Kind}`;
              const Page=await this.Get<{threads:DiscordChannel[];has_more:boolean}>(`${Base}${Query}`);
              for (const Item of Page.threads) Threads.set(Item.id,Item);
              if (!Page.has_more) break;
              const Next=JoinedPrivate?Page.threads.at(-1)?.id:Page.threads.at(-1)?.thread_metadata?.archive_timestamp;
              if (!Next||Next===Before) {Omissions.push(`Archive pagination did not advance for ${Parent.id}/${Kind}`);Completeness='partial';break;}
              Before=Next;
            } catch (Cause) {
              if (Kind==='private'&&!JoinedPrivate&&Cause instanceof DiscordError&&Cause.Status===403) {
                JoinedPrivate=true;Before=undefined;continue;
              }
              Omissions.push(`Archived ${Kind} threads unavailable for ${Parent.id}: ${Cause instanceof Error?Cause.message:String(Cause)}`);
              Completeness='partial';break;
            }
          }
        }
      }
    }
    return {guildId:GuildId,channels:SnapshotValue.channels,threads:[...Threads.values()],
      completeness:{channels:SnapshotValue.completeness.channels,threads:Completeness},omissions:Omissions};
  }
}
