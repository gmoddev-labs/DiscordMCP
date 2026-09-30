import { randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { BlueprintSchema, ChannelSpec, RoleSpec, Snowflake, type Channel, type Operation, type Plan, type Role, type GuildDesired } from './types.js';
import { DiscordAdapter, DiscordError, type DiscordChannel, type DiscordRole, type DiscordMember, type Snapshot } from './discord.js';
import { Store } from './store.js';
import { Bits, ChannelState, ChannelTypes, DesiredChannel, DesiredGuild, DesiredRole, GuildState, Hash, RoleState, SetHash, Structural } from './structural.js';
import {ChannelSettingsBody} from './channel-settings.js';
import {Assistant} from './assistant.js';

function RoleBody(Spec:Role):Record<string,unknown> {
  return DesiredRole(Spec);
}
function EditableRole(RoleValue:DiscordRole, SnapshotValue:Snapshot):boolean {
  return RoleValue.id!==SnapshotValue.guildId && !RoleValue.managed && RoleValue.position<SnapshotValue.capabilities.highestRolePosition;
}
function HasPermission(SnapshotValue:Snapshot,Name:string):boolean {
  return SnapshotValue.capabilities.permissions.includes('Administrator')||SnapshotValue.capabilities.permissions.includes(Name);
}
function OperationFor(Resource:Operation['resource'],Action:Operation['action'],Key?:string,TargetId?:string,Desired?:Operation['desired']):Operation {
  return {id:randomUUID(),resource:Resource,action:Action,key:Key,targetId:TargetId,desired:Desired,state:'pending'};
}

export class ControlPlane {
  private readonly GuildQueues=new Map<string,Promise<void>>();
  readonly Assistant:Assistant;
  constructor(readonly Discord:DiscordAdapter,readonly Store:Store) {this.Assistant=new Assistant(Discord,Store);}
  private async WithGuildMutation<T>(GuildId:string,Work:()=>Promise<T>,PlanId?:string,AllowUncertain=false):Promise<T> {
    const Previous=this.GuildQueues.get(GuildId)??Promise.resolve();
    let Release!:()=>void;
    const Gate=new Promise<void>(Resolve=>{Release=Resolve;});
    const Queued=Previous.then(()=>Gate);
    this.GuildQueues.set(GuildId,Queued);
    await Previous;
    try {
      if (this.Store.HasActivePlan(GuildId,PlanId)||(!AllowUncertain&&this.Store.HasUncertainAction(GuildId)))
        throw new Error('An active or uncertain mutation owns this guild');
      return await Work();
    } finally {
      Release();
      if (this.GuildQueues.get(GuildId)===Queued) this.GuildQueues.delete(GuildId);
    }
  }
  GetActiveServers() {return this.Discord.GetActiveServers();}
  GetServerSnapshot(GuildId:string,IncludeMembers=false) {return this.Discord.Snapshot(GuildId,IncludeMembers);}
  GetAllMembers(GuildId:string) {return this.Discord.GetAllMembers(GuildId);}
  GetAllChannels(GuildId:string,ThreadScope:'none'|'active'|'allAccessible'='none') {return this.Discord.GetAllChannels(GuildId,ThreadScope);}
  async GetCapabilities(GuildId:string) {
    const SnapshotValue=await this.Discord.Snapshot(GuildId);
    return {...SnapshotValue.capabilities,actions:{manageRoles:HasPermission(SnapshotValue,'ManageRoles'),
      kickMembers:HasPermission(SnapshotValue,'KickMembers'),banMembers:HasPermission(SnapshotValue,'BanMembers'),
      manageGuild:HasPermission(SnapshotValue,'ManageGuild'),moderateMembers:HasPermission(SnapshotValue,'ModerateMembers'),
      manageChannels:HasPermission(SnapshotValue,'ManageChannels')}};
  }
  async AdoptResource(GuildId:string,Kind:'role'|'channel',Key:string,ResourceId:string):Promise<{guildId:string;kind:string;key:string;resourceId:string}> {
    Snowflake.parse(GuildId); Snowflake.parse(ResourceId);
    return this.WithGuildMutation(GuildId,async()=>{
      const SnapshotValue=await this.Discord.Snapshot(GuildId);
      const List=Kind==='role'?SnapshotValue.roles:SnapshotValue.channels;
      if (!List.some(Item=>Item.id===ResourceId)) throw new Error('Exact resource ID is absent from snapshot');
      this.Store.SetMapping(GuildId,Kind,Key,ResourceId);
      return {guildId:GuildId,kind:Kind,key:Key,resourceId:ResourceId};
    });
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
      const Current=TargetId?SnapshotValue.channels.find(Item=>Item.id===TargetId):undefined;
      ChannelSettingsBody(ChannelTypes[ChannelSpecValue.type],ChannelSpecValue,Current);
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
    if (Existing&&TargetId) Preconditions[`${Kind}:${TargetId}`]=Structural(Existing,Kind);
    if (Action==='create'&&Spec) Preconditions[`absence:${Kind}:${encodeURIComponent(Spec.name)}`]='absent';
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
      Preconditions.channelSet=SetHash(SnapshotValue.channels.map(Item=>Item.id));
      const Unmanaged=SnapshotValue.channels.filter(Item=>Mode==='REPLACE'||!DesiredChannelIds.has(Item.id));
      for (const Item of [...Unmanaged.filter(Item=>Item.type!==ChannelType.GuildCategory),...Unmanaged.filter(Item=>Item.type===ChannelType.GuildCategory)]) {
        if (ProtectedChannels.has(Item.id)) throw new Error(`Protected channel ${Item.id} prevents pruning`);
        Operations.push(OperationFor('channel','delete',undefined,Item.id));
        Preconditions[`channel:${Item.id}`]=Structural(Item,'channel');
      }
    }
    if (Mode==='REPLACE'||BlueprintValue.policy?.pruneRoles) {
      Preconditions.editableRoleSet=SetHash(SnapshotValue.roles.filter(Item=>EditableRole(Item,SnapshotValue)).map(Item=>Item.id));
      for (const Item of SnapshotValue.roles) {
        if (Mode==='RECONCILE' && DesiredRoleIds.has(Item.id)) continue;
        if (!EditableRole(Item,SnapshotValue)) continue;
        Operations.push(OperationFor('role','delete',undefined,Item.id));
        Preconditions[`role:${Item.id}`]=Structural(Item,'role');
      }
    }
    for (const Spec of BlueprintValue.roles) {
      const Id=Mode==='REPLACE'?undefined:RoleMappings[Spec.key];
      const Existing=Id?SnapshotValue.roles.find(Item=>Item.id===Id):undefined;
      if (Id && !Existing) throw new Error(`Mapped role ${Spec.key} is missing; explicit repair required`);
      if (Existing && !EditableRole(Existing,SnapshotValue)) throw new Error(`Mapped role ${Spec.key} cannot be edited`);
      if (!Id && Mode==='RECONCILE' && SnapshotValue.roles.some(Item=>Item.name===Spec.name)) throw new Error(`Role ${Spec.name} exists without a mapping; adopt its exact ID first`);
      if (Existing) Preconditions[`role:${Existing.id}`]=Structural(Existing,'role');
      if (!Existing||Mode==='REPLACE') {
        Operations.push(OperationFor('role','create',Spec.key,undefined,Spec));
        if (Mode==='RECONCILE') Preconditions[`absence:role:${encodeURIComponent(Spec.name)}`]='absent';
      } else if (Hash(RoleState(Existing,Spec))!==Hash(DesiredRole(Spec))) {
        Operations.push(OperationFor('role','update',Spec.key,Existing.id,Spec));
        Preconditions[`role:${Existing.id}`]=Structural(Existing,'role');
      }
    }
    const OrderedChannels=[...BlueprintValue.channels.filter(Item=>Item.type==='category'),...BlueprintValue.channels.filter(Item=>Item.type!=='category')];
    for (const Spec of OrderedChannels) {
      const Id=Mode==='REPLACE'?undefined:ChannelMappings[Spec.key];
      const Existing=Id?SnapshotValue.channels.find(Item=>Item.id===Id):undefined;
      if (Id&&!Existing) throw new Error(`Mapped channel ${Spec.key} is missing; explicit repair required`);
      if (!Id && Mode==='RECONCILE' && SnapshotValue.channels.some(Item=>Item.name===Spec.name)) throw new Error(`Channel ${Spec.name} exists without a mapping; adopt its exact ID first`);
      if (Existing&&Existing.type!==ChannelTypes[Spec.type]) throw new Error(`Mapped channel ${Spec.key} has incompatible type`);
      if (Existing) Preconditions[`channel:${Existing.id}`]=Structural(Existing,'channel');
      if (!Existing||Mode==='REPLACE') {
        Operations.push(OperationFor('channel','create',Spec.key,undefined,Spec));
        if (Mode==='RECONCILE') Preconditions[`absence:channel:${encodeURIComponent(Spec.name)}`]='absent';
      } else {
        const DesiredParent=Spec.parent?ChannelMappings[Spec.parent]:undefined;
        const NewRoleReferences=Spec.overwrites.some(Entry=>Entry.target!=='@everyone'&&!RoleMappings[Entry.target]);
        const NewParent=Boolean(Spec.parent&&!DesiredParent);
        if (NewRoleReferences||NewParent||Hash(ChannelState(Existing,Spec))!==Hash(DesiredChannel(Spec,GuildId,RoleMappings,ChannelMappings,Existing))) {
          Operations.push(OperationFor('channel','update',Spec.key,Existing.id,Spec));
          Preconditions[`channel:${Existing.id}`]=Structural(Existing,'channel');
        }
      }
    }
    if (BlueprintValue.guild&&Object.values(BlueprintValue.guild).some(Value=>Value!==undefined)) {
      const Spec=BlueprintValue.guild;
      const Keys=[Spec.afkChannel,Spec.systemChannel,Spec.rulesChannel,Spec.publicUpdatesChannel,Spec.safetyAlertsChannel]
        .filter((Value):Value is string=>typeof Value==='string');
      for(const Key of Keys) {
        if(!BlueprintValue.channels.some(Item=>Item.key===Key)&&!ChannelMappings[Key])
          throw new Error(`Guild channel key ${Key} is not in blueprint or mapped`);
      }
      for(const [Key,Value] of Object.entries({afkChannel:Spec.afkChannel,systemChannel:Spec.systemChannel,
        rulesChannel:Spec.rulesChannel,publicUpdatesChannel:Spec.publicUpdatesChannel,safetyAlertsChannel:Spec.safetyAlertsChannel})) {
        if(typeof Value!=='string') continue;
        const Planned=BlueprintValue.channels.find(Item=>Item.key===Value);
        const Existing=SnapshotValue.channels.find(Item=>Item.id===ChannelMappings[Value]);
        const Type=Planned?ChannelTypes[Planned.type]:Existing?.type;
        if(Key==='afkChannel'?Type!==ChannelType.GuildVoice:
          ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(Type??-1))
          throw new Error(`Guild ${Key} references an incompatible channel`);
      }
      const Unresolved=Keys.some(Key=>!ChannelMappings[Key]);
      if(Unresolved||Hash(GuildState(SnapshotValue.guild,Spec))!==Hash(DesiredGuild(Spec,ChannelMappings))) {
        Operations.push(OperationFor('guild','update',undefined,GuildId,Spec));
        Preconditions[`guild:${GuildId}`]=Hash(GuildState(SnapshotValue.guild,Spec));
      }
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
      if (Target==='channelSet') {
        if (SetHash(SnapshotValue.channels.map(Item=>Item.id))!==Expected) throw new Error('PLAN_STALE: channel set changed after planning');
        continue;
      }
      if (Target==='editableRoleSet') {
        if (SetHash(SnapshotValue.roles.filter(Item=>EditableRole(Item,SnapshotValue)).map(Item=>Item.id))!==Expected)
          throw new Error('PLAN_STALE: editable role set changed after planning');
        continue;
      }
      const [Kind,Id]=Target.split(':');
      if (Kind==='absence') {
        const [,Resource,EncodedName]=Target.split(':');
        const Name=decodeURIComponent(EncodedName??'');
        const List=Resource==='role'?SnapshotValue.roles:SnapshotValue.channels;
        if (List.some(Item=>Item.name===Name)) throw new Error(`PLAN_STALE: ${Resource} name ${Name} appeared after planning`);
        continue;
      }
      const Current=Kind==='role'?SnapshotValue.roles.find(Item=>Item.id===Id):Kind==='channel'?SnapshotValue.channels.find(Item=>Item.id===Id):SnapshotValue.guild;
      const Actual=Kind==='guild'?Hash(GuildState(SnapshotValue.guild,PlanValue.blueprint.guild??{name:SnapshotValue.guild.name})):
        Structural(Current as DiscordRole|DiscordChannel|undefined,Kind as 'role'|'channel');
      if (Actual!==Expected) throw new Error(`PLAN_STALE: ${Target} changed after planning`);
    }
  }
  private async ChannelBody(GuildId:string,Spec:Channel,Current?:DiscordChannel):Promise<Record<string,unknown>> {
    const Desired=DesiredChannel(Spec,GuildId,this.Store.GetMappings(GuildId,'role'),this.Store.GetMappings(GuildId,'channel'),Current);
    const Body:Record<string,unknown>={name:Desired.name,type:Desired.type,parent_id:Desired.parent_id,
      permission_overwrites:Desired.permission_overwrites};
    if (Desired.type===ChannelType.GuildCategory) delete Body.parent_id;
    if ([ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.GuildForum,ChannelType.GuildMedia].includes(Desired.type)) Body.topic=Desired.topic;
    if (Desired.type!==ChannelType.GuildCategory&&Desired.type!==ChannelType.GuildStageVoice) Body.nsfw=Desired.nsfw;
    Object.assign(Body,ChannelSettingsBody(Desired.type,Spec,Current));
    if(Spec.position!==undefined) Body.position=Spec.position;
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
    if (OperationValue.resource==='guild') {
      const Body=DesiredGuild(OperationValue.desired as GuildDesired,this.Store.GetMappings(GuildId,'channel'));
      await this.Discord.Patch(`/guilds/${GuildId}`,Body,Reason);return;
    }
    if (OperationValue.resource==='role') {
      const Body=RoleBody(OperationValue.desired as Role);
      const Result=OperationValue.action==='create'
        ?await this.Discord.Post<{id:string}>(`/guilds/${GuildId}/roles`,Body,Reason)
        :await this.Discord.Patch<{id:string}>(`/guilds/${GuildId}/roles/${OperationValue.targetId}`,Body,Reason);
      OperationValue.resultId=Result.id;
    } else {
      const Current=OperationValue.action==='update'&&OperationValue.targetId?
        await this.Discord.RequireGuildChannel(GuildId,OperationValue.targetId):undefined;
      const Body=await this.ChannelBody(GuildId,OperationValue.desired as Channel,Current);
      if (OperationValue.action==='update') delete Body.type;
      const Result=OperationValue.action==='create'
        ?await this.Discord.Post<{id:string}>(`/guilds/${GuildId}/channels`,Body,Reason)
        :await this.Discord.Patch<{id:string}>(`/channels/${OperationValue.targetId}`,Body,Reason);
      OperationValue.resultId=Result.id;
    }
    if (OperationValue.key && OperationValue.resultId) this.Store.SetMapping(GuildId,OperationValue.resource,OperationValue.key,OperationValue.resultId);
  }
  async ApplyPlan(PlanId:string,Actor:string):Promise<Plan> {
    const Initial=this.Store.GetPlan(PlanId);
    if (!Initial) throw new Error('Plan not found');
    return this.WithGuildMutation(Initial.guildId,async()=>{
      const PlanValue=this.Store.GetPlan(PlanId);
      if (!PlanValue) throw new Error('Plan not found');
      if (PlanValue.actor!==Actor) throw new Error('Plan actor mismatch');
      if (PlanValue.status==='succeeded') return PlanValue;
      if (PlanValue.status==='abandoned') throw new Error('Abandoned plan is terminal');
      if (PlanValue.status==='failed') throw new Error('Failed plans are terminal; create a fresh plan');
      if (PlanValue.status==='uncertain'||PlanValue.operations.some(Item=>Item.state==='running')) throw new Error('Plan has an uncertain operation; inspect Discord and adopt/resolve it manually');
      if (PlanValue.status==='running') throw new Error('Interrupted running plan requires inspection and a fresh plan');
      await this.CheckPreconditions(PlanValue);
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
      PlanValue.status='succeeded';this.Store.SavePlan(PlanValue);
      return PlanValue;
    },PlanId);
  }
  async VerifyServer(PlanId:string):Promise<{planId:string;guildId:string;status:string;verified:boolean;issues:string[];snapshot:Snapshot}> {
    const PlanValue=this.Store.GetPlan(PlanId);
    if (!PlanValue) throw new Error('Plan not found');
    const SnapshotValue=await this.Discord.Snapshot(PlanValue.guildId);
    const Issues:string[]=[];
    for (const Item of PlanValue.operations) {
      if (Item.resource==='guild') {
        const Desired=Item.desired as GuildDesired;
        if(Hash(GuildState(SnapshotValue.guild,Desired))!==Hash(DesiredGuild(Desired,this.Store.GetMappings(PlanValue.guildId,'channel'))))
          Issues.push('Guild settings do not match');
        continue;
      }
      const List=Item.resource==='role'?SnapshotValue.roles:SnapshotValue.channels;
      if (Item.action==='delete') {
        if (List.some(Current=>Current.id===Item.targetId)) Issues.push(`${Item.resource} ${Item.targetId} still exists`);
      } else if (Item.state==='succeeded') {
        const Current=List.find(Entry=>Entry.id===(Item.resultId??Item.targetId));
        const Desired=Item.desired as Role|Channel;
        if (!Current) {
          Issues.push(`${Item.resource} ${Item.key??Item.targetId} mutation not observed`);continue;
        }
        const Actual=Item.resource==='role'?RoleState(Current as DiscordRole,Desired as Role):ChannelState(Current as DiscordChannel,Desired as Channel);
        const Wanted=Item.resource==='role'?DesiredRole(Desired as Role):DesiredChannel(Desired as Channel,PlanValue.guildId,
          this.Store.GetMappings(PlanValue.guildId,'role'),this.Store.GetMappings(PlanValue.guildId,'channel'));
        if (Hash(Actual)!==Hash(Wanted)) Issues.push(`${Item.resource} ${Item.key??Item.targetId} state does not match`);
      }
    }
    for (const Spec of PlanValue.blueprint.roles) {
      const Id=this.Store.GetMapping(PlanValue.guildId,'role',Spec.key);
      const Current=SnapshotValue.roles.find(Item=>Item.id===Id);
      if (!Current||Hash(RoleState(Current,Spec))!==Hash(DesiredRole(Spec))) Issues.push(`Role ${Spec.key} does not match`);
    }
    for (const Spec of PlanValue.blueprint.channels) {
      const Id=this.Store.GetMapping(PlanValue.guildId,'channel',Spec.key);
      const Current=SnapshotValue.channels.find(Item=>Item.id===Id);
      const Wanted=DesiredChannel(Spec,PlanValue.guildId,this.Store.GetMappings(PlanValue.guildId,'role'),this.Store.GetMappings(PlanValue.guildId,'channel'));
      if (!Current||Hash(ChannelState(Current,Spec))!==Hash(Wanted)) Issues.push(`Channel ${Spec.key} does not match`);
    }
    if (PlanValue.blueprint.guild&&Object.values(PlanValue.blueprint.guild).some(Value=>Value!==undefined)&&
      Hash(GuildState(SnapshotValue.guild,PlanValue.blueprint.guild))!==
        Hash(DesiredGuild(PlanValue.blueprint.guild,this.Store.GetMappings(PlanValue.guildId,'channel'))))
      Issues.push('Guild settings do not match');
    if (PlanValue.mode==='REPLACE'||PlanValue.blueprint.policy?.pruneChannels) {
      const Wanted=new Set(PlanValue.blueprint.channels.map(Spec=>this.Store.GetMapping(PlanValue.guildId,'channel',Spec.key)));
      for (const ChannelValue of SnapshotValue.channels) if (!Wanted.has(ChannelValue.id)) Issues.push(`Unexpected channel ${ChannelValue.id}`);
    }
    if (PlanValue.mode==='REPLACE'||PlanValue.blueprint.policy?.pruneRoles) {
      const Wanted=new Set(PlanValue.blueprint.roles.map(Spec=>this.Store.GetMapping(PlanValue.guildId,'role',Spec.key)));
      for (const RoleValue of SnapshotValue.roles) if (EditableRole(RoleValue,SnapshotValue)&&!Wanted.has(RoleValue.id)) Issues.push(`Unexpected mutable role ${RoleValue.id}`);
    }
    return {planId:PlanId,guildId:PlanValue.guildId,status:PlanValue.status,
      verified:PlanValue.operations.every(Item=>Item.state==='succeeded'||Item.state==='skipped')&&Issues.length===0,issues:Issues,snapshot:SnapshotValue};
  }
  async AddMemberRole(GuildId:string,UserId:string,RoleId:string,Actor:string):Promise<void> {
    Snowflake.parse(GuildId);Snowflake.parse(UserId);Snowflake.parse(RoleId);
    await this.RunDirect(GuildId,Actor,'add-role',UserId,async()=>{
      const SnapshotValue=await this.Discord.Snapshot(GuildId);
      if (!HasPermission(SnapshotValue,'ManageRoles')) throw new Error('Bot lacks MANAGE_ROLES');
      const RoleValue=SnapshotValue.roles.find(Item=>Item.id===RoleId);
      if (!RoleValue||!EditableRole(RoleValue,SnapshotValue)) throw new Error('Role cannot be assigned by this bot');
    },Id=>this.Discord.RequestPut(`/guilds/${GuildId}/members/${UserId}/roles/${RoleId}`,`DiscordControl action=${Id} actor=${Actor} add-role`));
  }
  async RemoveMemberRole(GuildId:string,UserId:string,RoleId:string,Actor:string):Promise<void> {
    Snowflake.parse(GuildId);Snowflake.parse(UserId);Snowflake.parse(RoleId);
    await this.RunDirect(GuildId,Actor,'remove-role',UserId,async()=>{
      const SnapshotValue=await this.Discord.Snapshot(GuildId);
      if (!HasPermission(SnapshotValue,'ManageRoles')) throw new Error('Bot lacks MANAGE_ROLES');
      const RoleValue=SnapshotValue.roles.find(Item=>Item.id===RoleId);
      if (!RoleValue||!EditableRole(RoleValue,SnapshotValue)) throw new Error('Role cannot be removed by this bot');
    },Id=>this.Discord.Delete(`/guilds/${GuildId}/members/${UserId}/roles/${RoleId}`,`DiscordControl action=${Id} actor=${Actor} remove-role`));
  }
  async KickMember(GuildId:string,UserId:string,Actor:string):Promise<void> {
    Snowflake.parse(GuildId);Snowflake.parse(UserId);
    await this.RunDirect(GuildId,Actor,'kick-member',UserId,async()=>{
      const SnapshotValue=await this.Discord.Snapshot(GuildId);
      if (!HasPermission(SnapshotValue,'KickMembers')) throw new Error('Bot lacks KICK_MEMBERS');
      await this.CheckMemberHierarchy(SnapshotValue,UserId);
    },Id=>this.Discord.Delete(`/guilds/${GuildId}/members/${UserId}`,`DiscordControl action=${Id} actor=${Actor} kick-member`));
  }
  async BanMember(GuildId:string,UserId:string,Actor:string,DeleteMessageSeconds=0):Promise<void> {
    Snowflake.parse(GuildId);Snowflake.parse(UserId);
    if (DeleteMessageSeconds<0||DeleteMessageSeconds>604800) throw new Error('deleteMessageSeconds out of range');
    await this.RunDirect(GuildId,Actor,'ban-member',UserId,async()=>{
      const SnapshotValue=await this.Discord.Snapshot(GuildId);
      if (!HasPermission(SnapshotValue,'BanMembers')) throw new Error('Bot lacks BAN_MEMBERS');
      await this.CheckMemberHierarchy(SnapshotValue,UserId,true);
    },Id=>this.Discord.RequestPut(`/guilds/${GuildId}/bans/${UserId}`,`DiscordControl action=${Id} actor=${Actor} ban-member`,{delete_message_seconds:DeleteMessageSeconds}));
  }
  async SetRolePositions(GuildId:string,Positions:{roleId:string;position:number}[],Actor:string):Promise<void> {
    Snowflake.parse(GuildId);
    if (!Positions.length||new Set(Positions.map(Item=>Item.roleId)).size!==Positions.length) throw new Error('Role positions must be nonempty and unique');
    await this.RunDirect(GuildId,Actor,'set-role-positions',GuildId,async()=>{
      const SnapshotValue=await this.Discord.Snapshot(GuildId);
      if (!HasPermission(SnapshotValue,'ManageRoles')) throw new Error('Bot lacks MANAGE_ROLES');
      for (const Item of Positions) {
        Snowflake.parse(Item.roleId);
        const RoleValue=SnapshotValue.roles.find(RoleEntry=>RoleEntry.id===Item.roleId);
        if (!RoleValue||!EditableRole(RoleValue,SnapshotValue)||Item.position<1||Item.position>=SnapshotValue.capabilities.highestRolePosition)
          throw new Error(`Role ${Item.roleId} cannot be moved to ${Item.position}`);
      }
    },async Id=>{
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
  async RunDirect<T>(GuildId:string,Actor:string,Kind:string,TargetId:string,
    Preflight:()=>Promise<void>,Action:(Id:string)=>Promise<T>):Promise<T> {
    return this.WithGuildMutation(GuildId,async()=>{
      await Preflight();
      const Id=`action_${randomUUID()}`;
      this.Store.RecordAction(Id,GuildId,Actor,Kind,TargetId,'running');
      try {const Result=await Action(Id);this.Store.RecordAction(Id,GuildId,Actor,Kind,TargetId,'succeeded');return Result;}
      catch (Cause) {
        const State=Cause instanceof DiscordError&&Cause.Status>=400&&Cause.Status<500?'failed':'uncertain';
        this.Store.RecordAction(Id,GuildId,Actor,Kind,TargetId,State,Cause instanceof Error?Cause.message:String(Cause));
        throw new Error(`${Cause instanceof Error?Cause.message:String(Cause)} (actionId=${Id}, state=${State})`,{cause:Cause});
      }
    });
  }
  GetUncertainActions(GuildId:string) {Snowflake.parse(GuildId);return this.Store.ListUncertainActions(GuildId);}
  async ResolveUncertainAction(ActionId:string,Actor:string):Promise<void> {
    const Action=this.Store.GetAction(ActionId);
    if (!Action) throw new Error('Action not found');
    await this.WithGuildMutation(Action.guild_id,async()=>this.Store.ResolveAction(ActionId,Actor),undefined,true);
  }
  async AbandonPlan(PlanId:string,Actor:string):Promise<Plan> {
    const Initial=this.Store.GetPlan(PlanId);
    if (!Initial||Initial.actor!==Actor) throw new Error('Plan not found for actor');
    return this.WithGuildMutation(Initial.guildId,async()=>{
      const PlanValue=this.Store.GetPlan(PlanId);
      if (!PlanValue||PlanValue.actor!==Actor) throw new Error('Plan not found for actor');
      if (!['running','uncertain','failed','planned'].includes(PlanValue.status)) throw new Error('Plan cannot be abandoned');
      PlanValue.status='abandoned';this.Store.SavePlan(PlanValue);
      return PlanValue;
    },PlanId);
  }
}
