import {z} from 'zod';
import {ChannelType} from 'discord.js';
import {Snowflake} from './types.js';
import {ChannelRecord,ChannelSettings,ChannelSettingsBody} from './channel-settings.js';
import {Define,type OperationDefinition} from './registry.js';
import type {ControlPlane} from './control.js';
import type {ActorIdentity} from './assistant-types.js';
import type {DiscordChannel,DiscordGuild} from './discord.js';

const Guild=z.strictObject({guildId:Snowflake});
const Channel=Guild.extend({channelId:Snowflake});
const GuildSettings=Guild.extend({name:z.string().min(2).max(100).optional(),description:z.string().max(120).nullable().optional(),
  afkChannelId:Snowflake.nullable().optional(),afkTimeout:z.union([z.literal(60),z.literal(300),z.literal(900),z.literal(1800),z.literal(3600)]).optional(),
  systemChannelId:Snowflake.nullable().optional(),systemChannelFlags:z.number().int().min(0).max(63).optional(),
  verificationLevel:z.number().int().min(0).max(4).optional(),defaultMessageNotifications:z.union([z.literal(0),z.literal(1)]).optional(),
  explicitContentFilter:z.number().int().min(0).max(2).optional(),preferredLocale:z.string().min(2).max(35).optional(),
  rulesChannelId:Snowflake.nullable().optional(),publicUpdatesChannelId:Snowflake.nullable().optional(),
  safetyAlertsChannelId:Snowflake.nullable().optional()});
const GuildFields:Record<string,string>={name:'name',description:'description',afkChannelId:'afk_channel_id',afkTimeout:'afk_timeout',
  systemChannelId:'system_channel_id',systemChannelFlags:'system_channel_flags',verificationLevel:'verification_level',
  defaultMessageNotifications:'default_message_notifications',explicitContentFilter:'explicit_content_filter',
  preferredLocale:'preferred_locale',rulesChannelId:'rules_channel_id',publicUpdatesChannelId:'public_updates_channel_id',
  safetyAlertsChannelId:'safety_alerts_channel_id'};
const Reason=(Actor:ActorIdentity,Id:string,Name:string)=>`DiscordControl action=${Id} actor=${Actor.id} ${Name}`;
export function GuildRecord(Value:DiscordGuild) {
  return {id:Value.id,name:Value.name,description:Value.description??null,icon:Value.icon??null,banner:Value.banner??null,
    afkChannelId:Value.afk_channel_id??null,afkTimeout:Value.afk_timeout,systemChannelId:Value.system_channel_id??null,
    systemChannelFlags:Value.system_channel_flags,rulesChannelId:Value.rules_channel_id??null,
    publicUpdatesChannelId:Value.public_updates_channel_id??null,safetyAlertsChannelId:Value.safety_alerts_channel_id??null,
    verificationLevel:Value.verification_level,defaultMessageNotifications:Value.default_message_notifications,
    explicitContentFilter:Value.explicit_content_filter,preferredLocale:Value.preferred_locale,
    features:Value.features??[],premiumTier:Value.premium_tier,vanityUrlCode:Value.vanity_url_code??null,
    readOnly:['icon','banner','features','premiumTier','vanityUrlCode']};
}
async function CheckGuildChannels(Control:ControlPlane,GuildId:string,Args:Record<string,unknown>) {
  for(const Key of ['afkChannelId','systemChannelId','rulesChannelId','publicUpdatesChannelId','safetyAlertsChannelId']) {
    const Id=Args[Key];if(typeof Id!=='string') continue;
    const Item=await Control.Discord.RequireGuildChannel(GuildId,Id);
    if(Key==='afkChannelId') {
      if(Item.type!==ChannelType.GuildVoice) throw new Error('AFK channel must be a voice channel');
    } else if(![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(Item.type))
      throw new Error(`${Key} must be a text or announcement channel`);
  }
}
export const AdminOperations:OperationDefinition[]=[
  Define('GetGuild','guild','read','Read normalized configuration for one exact guild.',Guild,async(C,A)=>{
    C.Discord.RequireGuild(A.guildId);
    return {guild:GuildRecord(await C.Discord.Get<DiscordGuild>(`/guilds/${A.guildId}`)),completeness:'exact-fetch'};
  },'guild.read'),
  Define('ModifyGuildSettings','guild','write','Modify a narrow typed set of guild settings.',GuildSettings,(C,A,Actor)=>{
    const Fields=Object.entries(A).filter(([Key,Value])=>Key!=='guildId'&&Value!==undefined);
    if(!Fields.length) throw new Error('At least one guild setting is required');
    return C.RunDirect(A.guildId,Actor.id,'modify-guild-settings',A.guildId,async()=>{
      C.Discord.RequireGuild(A.guildId);
      await CheckGuildChannels(C,A.guildId,A);
    },async Id=>{
      const Body=Object.fromEntries(Fields.map(([Key,Value])=>[GuildFields[Key],Value]));
      const Value=await C.Discord.Patch<DiscordGuild>(`/guilds/${A.guildId}`,Body,Reason(Actor,Id,'modify-guild-settings'));
      return {guildId:A.guildId,changed:Fields.map(([Key])=>Key),guild:GuildRecord(Value)};
    });
  },'guild.settings.write'),
  Define('GetChannel','channels','read','Read normalized state for one exact guild channel.',Channel,async(C,A)=>{
    const Item=await C.Discord.RequireGuildChannel(A.guildId,A.channelId);
    return {channel:ChannelRecord(A.guildId,Item),completeness:'exact-fetch'};
  },'guild.read'),
  Define('ModifyChannel','channels','write','Modify typed settings of one exact guild channel.',Channel.extend(ChannelSettings.shape),
    (C,A,Actor)=>{
      const {guildId:_GuildId,channelId:_ChannelId,...SettingsRaw}=A;
      const Settings=ChannelSettings.parse(SettingsRaw);
      if(!Object.values(Settings).some(Value=>Value!==undefined)) throw new Error('At least one channel setting is required');
      let Body:Record<string,unknown>;
      return C.RunDirect(A.guildId,Actor.id,'modify-channel',A.channelId,async()=>{
        const Current=await C.Discord.RequireGuildChannel(A.guildId,A.channelId);
        Body=ChannelSettingsBody(Current.type,Settings,Current);
      },async Id=>{
        const Result=await C.Discord.Patch<DiscordChannel>(`/channels/${A.channelId}`,Body,Reason(Actor,Id,'modify-channel'));
        return {guildId:A.guildId,channel:ChannelRecord(A.guildId,Result)};
      });
    },'channels.write'),
  Define('SetChannelPositions','channels','write','Move a bounded set of exact guild channels.',Guild.extend({positions:z.array(z.strictObject({
    channelId:Snowflake,position:z.number().int().min(0).optional(),parentId:Snowflake.nullable().optional(),
    lockPermissions:z.boolean().optional()
  })).min(1).max(100)}),(C,A,Actor)=>{
    type Position={channelId:string;position?:number;parentId?:string|null;lockPermissions?:boolean};
    if(new Set(A.positions.map((Item:Position)=>Item.channelId)).size!==A.positions.length) throw new Error('Duplicate channel IDs');
    const Body=A.positions.map((Item:Position)=>({id:Item.channelId,...(Item.position!==undefined?{position:Item.position}:{}),
      ...(Item.parentId!==undefined?{parent_id:Item.parentId}:{}),
      ...(Item.lockPermissions!==undefined?{lock_permissions:Item.lockPermissions}:{})}));
    return C.RunDirect(A.guildId,Actor.id,'set-channel-positions',A.guildId,async()=>{
      for(const Item of A.positions) {
        const Current=await C.Discord.RequireGuildChannel(A.guildId,Item.channelId);
        if(Item.parentId!==undefined&&Item.parentId!==null) {
          const Parent=await C.Discord.RequireGuildChannel(A.guildId,Item.parentId);
          if(Parent.type!==ChannelType.GuildCategory||Current.type===ChannelType.GuildCategory)
            throw new Error('Parent must be a category and target must be a child channel');
        }
      }
    },async Id=>{
      await C.Discord.Patch<void>(`/guilds/${A.guildId}/channels`,Body,Reason(Actor,Id,'set-channel-positions'));
      return {guildId:A.guildId,channelIds:A.positions.map((Item:Position)=>Item.channelId),updated:true};
    });
  },'channels.write'),
  Define('GetGuildInvites','invites','read','Read a bounded guild-wide invite list.',Guild.extend({limit:z.number().int().min(1).max(100).default(100)}),async(C,A)=>{
    C.Discord.RequireGuild(A.guildId);
    const Items=await C.Discord.Get<{code:string;guild?:{id:string};channel?:{id:string};uses?:number;max_uses?:number;max_age?:number}[]>(
      `/guilds/${A.guildId}/invites`);
    if(Items.some(Item=>Item.guild&&Item.guild.id!==A.guildId)) throw new Error('Invite response contains a foreign guild');
    return {guildId:A.guildId,items:Items.slice(0,A.limit).map(Item=>({code:Item.code,channelId:Item.channel?.id,
      url:`https://discord.gg/${Item.code}`,uses:Item.uses,maxUses:Item.max_uses,maxAge:Item.max_age})),
      total:Items.length,completeness:Items.length>A.limit?'truncated':'exact-fetch'};
  },'invites.manage')
];
