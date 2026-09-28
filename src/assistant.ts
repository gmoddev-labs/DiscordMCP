import {randomUUID} from 'node:crypto';
import {Snowflake} from './types.js';
import type {DiscordAdapter} from './discord.js';
import type {Store} from './store.js';
import type {ActorIdentity,Capability,OperatorNotification} from './assistant-types.js';
import {AuthorizationPolicy,OperationalError} from './authorization.js';

export class Assistant {
  readonly Policy:AuthorizationPolicy;
  private EventCount=0;
  constructor(readonly Discord:DiscordAdapter,readonly Store:Store,
    readonly RetentionDays=Number(process.env.CONTROL_EVENT_RETENTION_DAYS??30),
    DiscordOperatorIds=(process.env.CONTROL_DISCORD_OPERATOR_IDS??'').split(',').map(Value=>Value.trim()).filter(Boolean)) {
    if (!Number.isInteger(RetentionDays)||RetentionDays<1||RetentionDays>365) throw new Error('CONTROL_EVENT_RETENTION_DAYS must be 1-365');
    this.Policy=new AuthorizationPolicy(DiscordOperatorIds);
    this.Store.PruneEvents(RetentionDays);
    if (typeof this.Discord.OnEvent==='function') this.Discord.OnEvent(EventValue=>{
      this.Store.AppendEvent(EventValue);
      this.EventCount++;
      if (this.EventCount%100===0) this.Store.PruneEvents(this.RetentionDays);
    });
  }
  RegisterActor(Actor:ActorIdentity):void {this.Store.SaveActor(Actor);}
  Require(Actor:ActorIdentity,GuildId:string,Capability:Capability):void {
    Snowflake.parse(GuildId);this.Policy.Require(Actor,GuildId,Capability);
  }
  GetRecentActivity(Actor:ActorIdentity,GuildId:string,Limit=100,Cursor?:string,Since?:string,Until?:string) {
    this.Require(Actor,GuildId,'activity.read');
    const Page=this.Store.ListEvents(GuildId,Limit,Cursor,Since,Until);
    const Counts:Record<string,number>={};
    for (const EventValue of Page.items) Counts[EventValue.type]=(Counts[EventValue.type]??0)+1;
    return {...Page,counts:Counts,window:{since:Since,until:Until??new Date().toISOString()}};
  }
  CreateNotification(Actor:ActorIdentity,GuildId:string,Input:Pick<OperatorNotification,'severity'|'category'|'title'|'details'>) {
    this.Require(Actor,GuildId,'notifications.create');
    const Notification:OperatorNotification={id:`notification_${randomUUID()}`,guildId:GuildId,actorId:Actor.id,
      severity:Input.severity,category:Input.category,title:Input.title,details:Input.details,createdAt:new Date().toISOString()};
    this.Store.CreateNotification(Notification);
    return Notification;
  }
  GetNotifications(Actor:ActorIdentity,GuildId:string,Limit=50,Cursor?:string,UnacknowledgedOnly=false) {
    this.Require(Actor,GuildId,'notifications.read');
    return this.Store.ListNotifications(GuildId,Limit,Cursor,UnacknowledgedOnly);
  }
  AcknowledgeNotification(Actor:ActorIdentity,GuildId:string,NotificationId:string) {
    this.Require(Actor,GuildId,'notifications.acknowledge');
    if (!this.Store.AcknowledgeNotification(GuildId,NotificationId,Actor.id))
      throw new OperationalError('RESOURCE_NOT_FOUND','Notification is absent or already acknowledged',GuildId,NotificationId);
    return {ok:true};
  }
  GetOperatorBrief(Actor:ActorIdentity,GuildId:string,Since?:string) {
    this.Require(Actor,GuildId,'activity.read');
    const WindowStart=Since??new Date(Date.now()-86400000).toISOString();
    const Activity=this.GetRecentActivity(Actor,GuildId,200,undefined,WindowStart);
    const Notifications=this.GetNotifications(Actor,GuildId,50,undefined,true);
    return {guildId:GuildId,window:{since:WindowStart,until:new Date().toISOString()},
      activity:{counts:Activity.counts,events:Activity.items,nextCursor:Activity.nextCursor,completeness:Activity.completeness,
        source:Activity.source},
      notifications:{items:Notifications.items,nextCursor:Notifications.nextCursor,completeness:Notifications.completeness},
      limitations:['Activity includes only locally observed gateway events; offline time and older pages are not represented.']};
  }
}
