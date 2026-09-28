import { createHash, randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { BlueprintSchema, ChannelSpec, RoleSpec, Snowflake, type Channel, type Operation, type Plan, type Role } from './types.js';
import { DiscordAdapter, DiscordError, type DiscordChannel, type DiscordRole, type DiscordMember, type Snapshot } from './discord.js';
import { Store } from './store.js';

const ChannelTypes:Record<Channel['type'],number> = {
  category:ChannelType.GuildCategory,text:ChannelType.GuildText,voice:ChannelType.GuildVoice,
  forum:ChannelType.GuildForum,announcement:ChannelType.GuildAnnouncement,
  stage:ChannelType.GuildStageVoice,media:ChannelType.GuildMedia
};
function Hash(Value:unknown):string {return createHash('sha256').update(JSON.stringify(Value)).digest('hex');}
function Bits(Names:string[]):string {
  let Result=0n;
  for (const Name of Names) {
    const Key=Name.toLowerCase().split('_').map((Part,Index)=>Index?Part[0]?.toUpperCase()+Part.slice(1):Part).join('');
    const Actual=Key[0]?.toUpperCase()+Key.slice(1);
    const Bit=(PermissionFlagsBits as Record<string,bigint>)[Actual];
    if (Bit===undefined) throw new Error(`Unknown permission ${Name}`);
    Result|=Bit;
  }
  return Result.toString();
}
function RoleBody(Spec:Role):Record<string,unknown> {
  return {name:Spec.name,permissions:Bits(Spec.permissions),hoist:Spec.hoist??false,
    mentionable:Spec.mentionable??false,color:Spec.color??0};
}
function EditableRole(RoleValue:DiscordRole, SnapshotValue:Snapshot):boolean {
  return RoleValue.id!==SnapshotValue.guildId && !RoleValue.managed && RoleValue.position<SnapshotValue.capabilities.highestRolePosition;
}
function OperationFor(Resource:Operation['resource'],Action:Operation['action'],Key?:string,TargetId?:string,Desired?:Operation['desired']):Operation {
  return {id:randomUUID(),resource:Resource,action:Action,key:Key,targetId:TargetId,desired:Desired,state:'pending'};
}
function Structural(Item:DiscordRole|DiscordChannel|undefined):string {return Hash(Item??null);}

export class ControlPlane {
  private readonly Applying=new Set<string>();
  constructor(readonly Discord:DiscordAdapter,readonly Store:Store) {}
  GetActiveServers() {return this.Discord.GetActiveServers();}
  GetServerSnapshot(GuildId:string,IncludeMembers=false) {return this.Discord.Snapshot(GuildId,IncludeMembers);}
  GetAllMembers(GuildId:string) {return this.Discord.GetAllMembers(GuildId);}
  GetAllChannels(GuildId:string,ThreadScope:'none'|'active'|'allAccessible'='none') {return this.Discord.GetAllChannels(GuildId,ThreadScope);}
  async GetCapabilities(GuildId:string) {return (await this.Discord.Snapshot(GuildId)).capabilities;}
  async AdoptResource(GuildId:string,Kind:'role'|'channel',Key:string,ResourceId:string):Promise<{guildId:string;kind:string;key:string;resourceId:string}> {
    Snowflake.parse(GuildId); Snowflake.parse(ResourceId);
    if (this.Applying.has(GuildId)||this.Store.HasActivePlan(GuildId)) throw new Error('A plan is active for this guild');
    const SnapshotValue=await this.Discord.Snapshot(GuildId);
    const List=Kind==='role'?SnapshotValue.roles:SnapshotValue.channels;
    if (!List.some(Item=>Item.id===ResourceId)) throw new Error('Exact resource ID is absent from snapshot');
    this.Store.SetMapping(GuildId,Kind,Key,ResourceId);
    return {guildId:GuildId,kind:Kind,key:Key,resourceId:ResourceId};
  }
  private MappingHash(GuildId:string):string {
    return Hash({roles:this.Store.GetMappings(GuildId,'role'),channels:this.Store.GetMappings(GuildId,'channel')});
  }
  async PlanResourceMutation(GuildId:string,Kind:'role'|'channel',Action:'create'|'update'|'delete',Actor:string,RawSpec?:unknown,TargetId?:string):Promise<Plan> {
    Snowflake.parse(GuildId);
    if (Action!=='create') Snowflake.parse(TargetId);
    const SnapshotValue=await this.Discord.Snapshot(GuildId);
    if (!SnapshotValue.capabilities.permissions.includes('Administrator')) throw new Error('Bot needs Administrator for structural plan v1');
    if (this.Store.HasActivePlan(GuildId)) throw new Error('A running or uncertain plan already owns this guild');
    const Spec=Action==='delete'?undefined:Kind==='role'?RoleSpec.parse(RawSpec):ChannelSpec.parse(RawSpec);
    if (Kind==='role'&&Spec) Bits((Spec as Role).permissions);
    if (Kind==='channel'&&Spec) {
      const ChannelSpecValue=Spec as Channel;
      if (ChannelSpecValue.parent&&!this.Store.GetMapping(GuildId,'channel',ChannelSpecValue.parent)) throw new Error('Parent category key is not mapped');
      for (const Overwrite of ChannelSpecValue.overwrites) {
        Bits(Overwrite.allow);Bits(Overwrite.deny);
        if (Overwrite.target!=='@everyone'&&!this.Store.GetMapping(GuildId,'role',Overwrite.target)) throw new Error(`Overwrite role ${Overwrite.target} is not mapped`);
      }
    }
    const List=Kind==='role'?SnapshotValue.roles:SnapshotValue.channels;
    const Existing=TargetId?List.find(Item=>Item.id===TargetId):undefined;
    if (Action!=='create'&&!Existing) throw new Error('Exact resource ID is absent from snapshot');
    if (Kind==='role'&&Existing&&!EditableRole(Existing as DiscordRole,SnapshotValue)) throw new Error('Role is not editable by this bot');
    if (Kind==='channel'&&Action==='delete'&&[SnapshotValue.guild.rules_channel_id,SnapshotValue.guild.public_updates_channel_id].includes(TargetId))
      throw new Error('Community Rules/Updates channel requires dedicated reconfiguration');
    if (Kind==='channel'&&Action==='update'&&Existing&&(Existing as DiscordChannel).type!==ChannelTypes[(Spec as Channel).type])
      throw new Error('Channel type change is not supported by focused updates');
    if (Action==='create'&&Spec) {
      if (List.some(Item=>Item.name===Spec.name)) throw new Error('Resource name exists; adopt its exact ID before updating');
      if (this.Store.GetMapping(GuildId,Kind,Spec.key)) throw new Error('Semantic key is already mapped');
    }
    if (Action==='update'&&Spec) {
      const Mapped=this.Store.GetMapping(GuildId,Kind,Spec.key);
      if (Mapped&&Mapped!==TargetId) throw new Error('Semantic key belongs to a different exact resource ID');
    }
    const OperationValue=OperationFor(Kind,Action,Spec?.key,TargetId,Spec as Role|Channel|undefined);
    const Preconditions:Record<string,string>={};
    if (Existing&&TargetId) Preconditions[`${Kind}:${TargetId}`]=Structural(Existing);
    const EmptyBlueprint=BlueprintSchema.parse({version:1,roles:[],channels:[]});
    const Now=new Date().toISOString();
    const PlanValue:Plan={id:`plan_${randomUUID()}`,guildId:GuildId,actor:Actor,mode:'RECONCILE',blueprint:EmptyBlueprint,
      blueprintHash:Hash(EmptyBlueprint),mappingHash:this.MappingHash(GuildId),preconditions:Preconditions,operations:[OperationValue],status:'planned',createdAt:Now,updatedAt:Now};
    this.Store.SavePlan(PlanValue);
    return PlanValue;
  }
  async PlanServer(GuildId:string,RawBlueprint:unknown,Mode:'RECONCILE'|'REPLACE',Actor:string):Promise<Plan> {
    Snowflake.parse(GuildId);
    const BlueprintValue=BlueprintSchema.parse(RawBlueprint);
    const SnapshotValue=await this.Discord.Snapshot(GuildId);
    if (this.Store.HasActivePlan(GuildId)) throw new Error('A running or uncertain plan already owns this guild');
    if ((Mode==='REPLACE'||BlueprintValue.policy?.pruneChannels) && SnapshotValue.completeness.channels!=='complete')
      throw new Error('Channel snapshot is not proven complete; destructive pruning refused');
    const Administrator=SnapshotValue.capabilities.permissions.includes('Administrator');
    if (!Administrator) throw new Error('Bot needs Administrator for structural plan v1');
    for (const RoleValue of BlueprintValue.roles) Bits(RoleValue.permissions);
    for (const ChannelValue of BlueprintValue.channels) for (const Overwrite of ChannelValue.overwrites) {
      Bits(Overwrite.allow); Bits(Overwrite.deny);
      if (Overwrite.target!=='@everyone' && !BlueprintValue.roles.some(RoleValue=>RoleValue.key===Overwrite.target))
        throw new Error(`Overwrite target ${Overwrite.target} is not a blueprint role`);
    }
    const Operations:Operation[]=[];
    const Preconditions:Record<string,string>={};
    const RoleMappings=this.Store.GetMappings(GuildId,'role');
    const ChannelMappings=this.Store.GetMappings(GuildId,'channel');
    const ProtectedChannels=new Set([SnapshotValue.guild.rules_channel_id,SnapshotValue.guild.public_updates_channel_id].filter(Boolean));
    const DesiredRoleIds=new Set(BlueprintValue.roles.map(Spec=>RoleMappings[Spec.key]).filter(Boolean));
    const DesiredChannelIds=new Set(BlueprintValue.channels.map(Spec=>ChannelMappings[Spec.key]).filter(Boolean));
    if (Mode==='REPLACE' && ProtectedChannels.size) throw new Error('Community Rules/Updates channels require an explicit reconfiguration path before REPLACE');
    if (Mode==='REPLACE'||BlueprintValue.policy?.pruneChannels) {
      const Unmanaged=SnapshotValue.channels.filter(Item=>Mode==='REPLACE'||!DesiredChannelIds.has(Item.id));
      for (const Item of [...Unmanaged.filter(Item=>Item.type!==ChannelType.GuildCategory),...Unmanaged.filter(Item=>Item.type===ChannelType.GuildCategory)]) {
        if (ProtectedChannels.has(Item.id)) throw new Error(`Protected channel ${Item.id} prevents pruning`);
        Operations.push(OperationFor('channel','delete',undefined,Item.id));
        Preconditions[`channel:${Item.id}`]=Structural(Item);
      }
    }
    if (Mode==='REPLACE'||BlueprintValue.policy?.pruneRoles) {
      for (const Item of SnapshotValue.roles) {
        if (Mode==='RECONCILE' && DesiredRoleIds.has(Item.id)) continue;
        if (!EditableRole(Item,SnapshotValue)) continue;
        Operations.push(OperationFor('role','delete',undefined,Item.id));
        Preconditions[`role:${Item.id}`]=Structural(Item);
      }
    }
    for (const Spec of BlueprintValue.roles) {
      const Id=Mode==='REPLACE'?undefined:RoleMappings[Spec.key];
      const Existing=Id?SnapshotValue.roles.find(Item=>Item.id===Id):undefined;
      if (Id && !Existing) throw new Error(`Mapped role ${Spec.key} is missing; explicit repair required`);
      if (Existing && !EditableRole(Existing,SnapshotValue)) throw new Error(`Mapped role ${Spec.key} cannot be edited`);
      if (!Id && Mode==='RECONCILE' && SnapshotValue.roles.some(Item=>Item.name===Spec.name)) throw new Error(`Role ${Spec.name} exists without a mapping; adopt its exact ID first`);
      Operations.push(OperationFor('role',Existing?'update':'create',Spec.key,Existing?.id,Spec));
      if (Existing) Preconditions[`role:${Existing.id}`]=Structural(Existing);
    }
    const OrderedChannels=[...BlueprintValue.channels.filter(Item=>Item.type==='category'),...BlueprintValue.channels.filter(Item=>Item.type!=='category')];
    for (const Spec of OrderedChannels) {
      const Id=Mode==='REPLACE'?undefined:ChannelMappings[Spec.key];
      const Existing=Id?SnapshotValue.channels.find(Item=>Item.id===Id):undefined;
      if (Id&&!Existing) throw new Error(`Mapped channel ${Spec.key} is missing; explicit repair required`);
      if (!Id && Mode==='RECONCILE' && SnapshotValue.channels.some(Item=>Item.name===Spec.name)) throw new Error(`Channel ${Spec.name} exists without a mapping; adopt its exact ID first`);
      Operations.push(OperationFor('channel',Existing?'update':'create',Spec.key,Existing?.id,Spec));
      if (Existing) Preconditions[`channel:${Existing.id}`]=Structural(Existing);
    }
    if (BlueprintValue.guild?.name && SnapshotValue.guild.name!==BlueprintValue.guild.name) {
      Operations.push(OperationFor('guild','update',undefined,GuildId,{name:BlueprintValue.guild.name}));
      Preconditions[`guild:${GuildId}`]=Hash({name:SnapshotValue.guild.name});
    }
    const Now=new Date().toISOString();
    const PlanValue:Plan={id:`plan_${randomUUID()}`,guildId:GuildId,actor:Actor,mode:Mode,blueprint:BlueprintValue,
      blueprintHash:Hash(BlueprintValue),mappingHash:this.MappingHash(GuildId),preconditions:Preconditions,operations:Operations,status:'planned',createdAt:Now,updatedAt:Now};
    this.Store.SavePlan(PlanValue);
    return PlanValue;
  }
  private async CheckPreconditions(PlanValue:Plan):Promise<void> {
    if (this.MappingHash(PlanValue.guildId)!==PlanValue.mappingHash) throw new Error('PLAN_STALE: semantic resource mappings changed after planning');
    const SnapshotValue=await this.Discord.Snapshot(PlanValue.guildId);
    for (const [Target,Expected] of Object.entries(PlanValue.preconditions)) {
      const [Kind,Id]=Target.split(':');
      const Current=Kind==='role'?SnapshotValue.roles.find(Item=>Item.id===Id):Kind==='channel'?SnapshotValue.channels.find(Item=>Item.id===Id):{name:SnapshotValue.guild.name};
      const Actual=Kind==='guild'?Hash(Current):Structural(Current as DiscordRole|DiscordChannel|undefined);
      if (Actual!==Expected) throw new Error(`PLAN_STALE: ${Target} changed after planning`);
    }
  }
  private async ChannelBody(GuildId:string,Spec:Channel,Existing?:DiscordChannel):Promise<Record<string,unknown>> {
    const ParentId=Spec.parent?this.Store.GetMapping(GuildId,'channel',Spec.parent):undefined;
    if (Spec.parent&&!ParentId) throw new Error(`Category ${Spec.parent} is not mapped`);
    const Overwrites=Spec.overwrites.map(Entry=>{
      const Id=Entry.target==='@everyone'?GuildId:this.Store.GetMapping(GuildId,'role',Entry.target);
      if (!Id) throw new Error(`Role ${Entry.target} is not mapped`);
      return {id:Id,type:0,allow:Bits(Entry.allow),deny:Bits(Entry.deny)};
    });
    const Body:Record<string,unknown>={name:Spec.name,type:ChannelTypes[Spec.type]};
    if (!Existing||Spec.parent!==undefined) Body.parent_id=ParentId??null;
    if (!Existing) Body.permission_overwrites=Overwrites;
    else if (Overwrites.length) {
      const Replaced=new Set(Overwrites.map(Item=>Item.id));
      Body.permission_overwrites=[...(Existing.permission_overwrites??[]).filter(Item=>!Replaced.has(Item.id)),...Overwrites];
    }
    if (Spec.topic!==undefined) Body.topic=Spec.topic;
    if (Spec.nsfw!==undefined) Body.nsfw=Spec.nsfw;
    return Body;
  }
  private async Execute(PlanValue:Plan,OperationValue:Operation):Promise<void> {
    const GuildId=PlanValue.guildId;
    const Reason=`DiscordControl plan=${PlanValue.id} actor=${PlanValue.actor} operation=${OperationValue.id}`;
    if (OperationValue.action==='delete' && OperationValue.targetId) {
      if (OperationValue.resource==='channel') await this.Discord.Delete(`/channels/${OperationValue.targetId}`,Reason);
      else if (OperationValue.resource==='role') await this.Discord.Delete(`/guilds/${GuildId}/roles/${OperationValue.targetId}`,Reason);
      this.Store.DeleteMappingById(GuildId,OperationValue.resource,OperationValue.targetId);
      return;
    }
    if (OperationValue.resource==='guild') {await this.Discord.Patch(`/guilds/${GuildId}`,OperationValue.desired,Reason);return;}
    if (OperationValue.resource==='role') {
      const Body=RoleBody(OperationValue.desired as Role);
      const Result=OperationValue.action==='create'
        ?await this.Discord.Post<{id:string}>(`/guilds/${GuildId}/roles`,Body,Reason)
        :await this.Discord.Patch<{id:string}>(`/guilds/${GuildId}/roles/${OperationValue.targetId}`,Body,Reason);
      OperationValue.resultId=Result.id;
    } else {
      const Existing=OperationValue.action==='update'?await this.Discord.Get<DiscordChannel>(`/channels/${OperationValue.targetId}`):undefined;
      const Body=await this.ChannelBody(GuildId,OperationValue.desired as Channel,Existing);
      if (OperationValue.action==='update') delete Body.type;
      const Result=OperationValue.action==='create'
        ?await this.Discord.Post<{id:string}>(`/guilds/${GuildId}/channels`,Body,Reason)
        :await this.Discord.Patch<{id:string}>(`/channels/${OperationValue.targetId}`,Body,Reason);
      OperationValue.resultId=Result.id;
    }
    if (OperationValue.key && OperationValue.resultId) this.Store.SetMapping(GuildId,OperationValue.resource,OperationValue.key,OperationValue.resultId);
  }
  async ApplyPlan(PlanId:string,Actor:string):Promise<Plan> {
    const PlanValue=this.Store.GetPlan(PlanId);
    if (!PlanValue) throw new Error('Plan not found');
    if (PlanValue.actor!==Actor) throw new Error('Plan actor mismatch');
    if (PlanValue.status==='succeeded') return PlanValue;
    if (PlanValue.status==='uncertain'||PlanValue.operations.some(Item=>Item.state==='running')) throw new Error('Plan has an uncertain operation; inspect Discord and adopt/resolve it manually');
    if (this.Applying.has(PlanValue.guildId)||this.Store.HasActivePlan(PlanValue.guildId,PlanId)) throw new Error('Another plan is active for this guild');
    this.Applying.add(PlanValue.guildId);
    try {
      if (PlanValue.status==='planned') await this.CheckPreconditions(PlanValue);
      PlanValue.status='running';this.Store.SavePlan(PlanValue);
      for (const Item of PlanValue.operations) {
        if (Item.state==='succeeded'||Item.state==='skipped') continue;
        Item.state='running';this.Store.SavePlan(PlanValue);
        try {await this.Execute(PlanValue,Item);Item.state='succeeded';this.Store.SavePlan(PlanValue);}
        catch (Cause) {
          Item.error=Cause instanceof Error?Cause.message:String(Cause);
          Item.state=Cause instanceof DiscordError && Cause.Status>=400 && Cause.Status<500?'failed':'running';
          PlanValue.status=Item.state==='running'?'uncertain':'failed';this.Store.SavePlan(PlanValue);
          throw Cause;
        }
      }
      PlanValue.status='succeeded';this.Store.SavePlan(PlanValue);
      let Verification:Awaited<ReturnType<ControlPlane['VerifyServer']>>;
      try {Verification=await this.VerifyServer(PlanId);}
      catch (Cause) {
        PlanValue.status='uncertain';this.Store.SavePlan(PlanValue);
        throw Cause;
      }
      if (!Verification.verified) {
        PlanValue.status='failed';this.Store.SavePlan(PlanValue);
        throw new Error(`Verification failed: ${Verification.issues.join('; ')}`);
      }
      return PlanValue;
    } finally {this.Applying.delete(PlanValue.guildId);}
  }
  async VerifyServer(PlanId:string):Promise<{planId:string;guildId:string;status:string;verified:boolean;issues:string[];snapshot:Snapshot}> {
    const PlanValue=this.Store.GetPlan(PlanId);
    if (!PlanValue) throw new Error('Plan not found');
    const SnapshotValue=await this.Discord.Snapshot(PlanValue.guildId);
    const Issues:string[]=[];
    for (const Item of PlanValue.operations) {
      if (Item.resource==='guild') continue;
      const List=Item.resource==='role'?SnapshotValue.roles:SnapshotValue.channels;
      if (Item.action==='delete') {
        if (List.some(Current=>Current.id===Item.targetId)) Issues.push(`${Item.resource} ${Item.targetId} still exists`);
      } else if (Item.state==='succeeded') {
        const Current=List.find(Entry=>Entry.id===(Item.resultId??Item.targetId));
        const Desired=Item.desired as Role|Channel;
        if (!Current||Current.name!==Desired.name) {
          Issues.push(`${Item.resource} ${Item.key??Item.targetId} mutation not observed`);continue;
        }
        if (Item.resource==='role'&&(Current as DiscordRole).permissions!==Bits((Desired as Role).permissions))
          Issues.push(`Role ${Item.key??Item.targetId} permissions not observed`);
        if (Item.resource==='channel') {
          const ChannelDesired=Desired as Channel;
          const ChannelCurrent=Current as DiscordChannel;
          if (ChannelCurrent.type!==ChannelTypes[ChannelDesired.type]) Issues.push(`Channel ${Item.key??Item.targetId} type not observed`);
          if (ChannelDesired.parent!==undefined) {
            const ParentId=this.Store.GetMapping(PlanValue.guildId,'channel',ChannelDesired.parent);
            if ((ChannelCurrent.parent_id??null)!==(ParentId??null)) Issues.push(`Channel ${Item.key??Item.targetId} parent not observed`);
          }
          for (const Overwrite of ChannelDesired.overwrites) {
            const Target=Overwrite.target==='@everyone'?PlanValue.guildId:this.Store.GetMapping(PlanValue.guildId,'role',Overwrite.target);
            const Actual=ChannelCurrent.permission_overwrites?.find(Entry=>Entry.id===Target);
            if (!Actual||Actual.allow!==Bits(Overwrite.allow)||Actual.deny!==Bits(Overwrite.deny))
              Issues.push(`Channel ${Item.key??Item.targetId} overwrite ${Overwrite.target} not observed`);
          }
        }
      }
    }
    for (const Spec of PlanValue.blueprint.roles) {
      const Id=this.Store.GetMapping(PlanValue.guildId,'role',Spec.key);
      const Current=SnapshotValue.roles.find(Item=>Item.id===Id);
      if (!Current||Current.name!==Spec.name||Current.permissions!==Bits(Spec.permissions)) Issues.push(`Role ${Spec.key} does not match`);
    }
    for (const Spec of PlanValue.blueprint.channels) {
      const Id=this.Store.GetMapping(PlanValue.guildId,'channel',Spec.key);
      const Current=SnapshotValue.channels.find(Item=>Item.id===Id);
      const Parent=Spec.parent?this.Store.GetMapping(PlanValue.guildId,'channel',Spec.parent):undefined;
      if (!Current||Current.name!==Spec.name||Current.type!==ChannelTypes[Spec.type]||(Spec.parent!==undefined&&(Current.parent_id??null)!==(Parent??null))) {
        Issues.push(`Channel ${Spec.key} does not match`);continue;
      }
      for (const Overwrite of Spec.overwrites) {
        const Target=Overwrite.target==='@everyone'?PlanValue.guildId:this.Store.GetMapping(PlanValue.guildId,'role',Overwrite.target);
        const Actual=Current.permission_overwrites?.find(Item=>Item.id===Target);
        if (!Actual||Actual.allow!==Bits(Overwrite.allow)||Actual.deny!==Bits(Overwrite.deny)) Issues.push(`Channel ${Spec.key} overwrite ${Overwrite.target} does not match`);
      }
    }
    if (PlanValue.mode==='REPLACE'||PlanValue.blueprint.policy?.pruneChannels) {
      const Wanted=new Set(PlanValue.blueprint.channels.map(Spec=>this.Store.GetMapping(PlanValue.guildId,'channel',Spec.key)));
      for (const ChannelValue of SnapshotValue.channels) if (!Wanted.has(ChannelValue.id)) Issues.push(`Unexpected channel ${ChannelValue.id}`);
    }
    if (PlanValue.mode==='REPLACE'||PlanValue.blueprint.policy?.pruneRoles) {
      const Wanted=new Set(PlanValue.blueprint.roles.map(Spec=>this.Store.GetMapping(PlanValue.guildId,'role',Spec.key)));
      for (const RoleValue of SnapshotValue.roles) if (EditableRole(RoleValue,SnapshotValue)&&!Wanted.has(RoleValue.id)) Issues.push(`Unexpected mutable role ${RoleValue.id}`);
    }
    return {planId:PlanId,guildId:PlanValue.guildId,status:PlanValue.status,verified:PlanValue.status==='succeeded'&&Issues.length===0,issues:Issues,snapshot:SnapshotValue};
  }
  async AddMemberRole(GuildId:string,UserId:string,RoleId:string,Actor:string):Promise<void> {
    Snowflake.parse(GuildId);Snowflake.parse(UserId);Snowflake.parse(RoleId);
    const SnapshotValue=await this.Discord.Snapshot(GuildId);
    const RoleValue=SnapshotValue.roles.find(Item=>Item.id===RoleId);
    if (!RoleValue||!EditableRole(RoleValue,SnapshotValue)) throw new Error('Role cannot be assigned by this bot');
    await this.RunDirect(GuildId,Actor,'add-role',UserId,Id=>this.Discord.RequestPut(`/guilds/${GuildId}/members/${UserId}/roles/${RoleId}`,`DiscordControl action=${Id} actor=${Actor} add-role`));
  }
  async RemoveMemberRole(GuildId:string,UserId:string,RoleId:string,Actor:string):Promise<void> {
    Snowflake.parse(GuildId);Snowflake.parse(UserId);Snowflake.parse(RoleId);
    const SnapshotValue=await this.Discord.Snapshot(GuildId);
    const RoleValue=SnapshotValue.roles.find(Item=>Item.id===RoleId);
    if (!RoleValue||!EditableRole(RoleValue,SnapshotValue)) throw new Error('Role cannot be removed by this bot');
    await this.RunDirect(GuildId,Actor,'remove-role',UserId,Id=>this.Discord.Delete(`/guilds/${GuildId}/members/${UserId}/roles/${RoleId}`,`DiscordControl action=${Id} actor=${Actor} remove-role`));
  }
  async KickMember(GuildId:string,UserId:string,Actor:string):Promise<void> {
    Snowflake.parse(GuildId);Snowflake.parse(UserId);
    const SnapshotValue=await this.Discord.Snapshot(GuildId);
    await this.CheckMemberHierarchy(SnapshotValue,UserId);
    await this.RunDirect(GuildId,Actor,'kick-member',UserId,Id=>this.Discord.Delete(`/guilds/${GuildId}/members/${UserId}`,`DiscordControl action=${Id} actor=${Actor} kick-member`));
  }
  async BanMember(GuildId:string,UserId:string,Actor:string,DeleteMessageSeconds=0):Promise<void> {
    Snowflake.parse(GuildId);Snowflake.parse(UserId);
    if (DeleteMessageSeconds<0||DeleteMessageSeconds>604800) throw new Error('deleteMessageSeconds out of range');
    const SnapshotValue=await this.Discord.Snapshot(GuildId);
    await this.CheckMemberHierarchy(SnapshotValue,UserId,true);
    await this.RunDirect(GuildId,Actor,'ban-member',UserId,Id=>this.Discord.RequestPut(`/guilds/${GuildId}/bans/${UserId}`,`DiscordControl action=${Id} actor=${Actor} ban-member`,{delete_message_seconds:DeleteMessageSeconds}));
  }
  async SetRolePositions(GuildId:string,Positions:{roleId:string;position:number}[],Actor:string):Promise<void> {
    Snowflake.parse(GuildId);
    if (!Positions.length||new Set(Positions.map(Item=>Item.roleId)).size!==Positions.length) throw new Error('Role positions must be nonempty and unique');
    const SnapshotValue=await this.Discord.Snapshot(GuildId);
    for (const Item of Positions) {
      Snowflake.parse(Item.roleId);
      const RoleValue=SnapshotValue.roles.find(RoleEntry=>RoleEntry.id===Item.roleId);
      if (!RoleValue||!EditableRole(RoleValue,SnapshotValue)||Item.position<1||Item.position>=SnapshotValue.capabilities.highestRolePosition)
        throw new Error(`Role ${Item.roleId} cannot be moved to ${Item.position}`);
    }
    await this.RunDirect(GuildId,Actor,'set-role-positions',GuildId,async Id=>{
      await this.Discord.Patch(`/guilds/${GuildId}/roles`,Positions.map(Item=>({id:Item.roleId,position:Item.position})),
        `DiscordControl action=${Id} actor=${Actor} set-role-positions`);
      const After=await this.Discord.Snapshot(GuildId);
      for (const Item of Positions) if (After.roles.find(RoleValue=>RoleValue.id===Item.roleId)?.position!==Item.position)
        throw new Error(`Role position ${Item.roleId} was not observed`);
    });
  }
  private async CheckMemberHierarchy(SnapshotValue:Snapshot,UserId:string,AllowAbsent=false):Promise<void> {
    if (UserId===SnapshotValue.guild.owner_id) throw new Error('Guild owner cannot be moderated');
    let Member:DiscordMember;
    try {Member=await this.Discord.Get<DiscordMember>(`/guilds/${SnapshotValue.guildId}/members/${UserId}`);}
    catch (Cause) {if (AllowAbsent&&Cause instanceof DiscordError&&Cause.Status===404) return;throw Cause;}
    const Highest=Math.max(0,...SnapshotValue.roles.filter(RoleValue=>Member.roles.includes(RoleValue.id)).map(RoleValue=>RoleValue.position));
    if (Highest>=SnapshotValue.capabilities.highestRolePosition) throw new Error('Target member is at or above the bot role hierarchy');
  }
  private async RunDirect(GuildId:string,Actor:string,Kind:string,TargetId:string,Action:(Id:string)=>Promise<void>):Promise<void> {
    if (this.Applying.has(GuildId)||this.Store.HasActivePlan(GuildId)) throw new Error('A plan is active for this guild');
    const Id=`action_${randomUUID()}`;
    this.Store.RecordAction(Id,GuildId,Actor,Kind,TargetId,'running');
    try {await Action(Id);this.Store.RecordAction(Id,GuildId,Actor,Kind,TargetId,'succeeded');}
    catch (Cause) {
      const State=Cause instanceof DiscordError&&Cause.Status>=400&&Cause.Status<500?'failed':'uncertain';
      this.Store.RecordAction(Id,GuildId,Actor,Kind,TargetId,State,Cause instanceof Error?Cause.message:String(Cause));
      throw Cause;
    }
  }
}
