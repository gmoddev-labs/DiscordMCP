import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Plan } from './types.js';
import { ApplyMigrations } from './migrations.js';
import type { ActorIdentity, OperationalEvent, OperatorNotification, Page } from './assistant-types.js';
import {NormalizeEvent} from './events.js';

export class Store {
  readonly Db: Database.Database;
  constructor(Path: string) {
    mkdirSync(dirname(Path), {recursive: true});
    this.Db = new Database(Path);
    this.Db.pragma('journal_mode = WAL');
    ApplyMigrations(this.Db);
  }
  GetPlan(Id: string): Plan | undefined {
    const Row = this.Db.prepare('SELECT body FROM plans WHERE id=?').get(Id) as {body: string} | undefined;
    return Row ? JSON.parse(Row.body) as Plan : undefined;
  }
  SavePlan(PlanValue: Plan): void {
    PlanValue.updatedAt = new Date().toISOString();
    PlanValue.actorIdentity??=this.GetActor(PlanValue.actor);
    this.Db.prepare(`INSERT INTO plans(id,guild_id,status,body) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body`).run(PlanValue.id, PlanValue.guildId, PlanValue.status, JSON.stringify(PlanValue));
  }
  GetMapping(GuildId: string, Kind: string, Key: string): string | undefined {
    return (this.Db.prepare('SELECT resource_id FROM mappings WHERE guild_id=? AND kind=? AND semantic_key=?')
      .get(GuildId, Kind, Key) as {resource_id: string} | undefined)?.resource_id;
  }
  SetMapping(GuildId: string, Kind: string, Key: string, Id: string): void {
    this.Db.prepare(`INSERT INTO mappings VALUES(?,?,?,?) ON CONFLICT(guild_id,kind,semantic_key)
      DO UPDATE SET resource_id=excluded.resource_id`).run(GuildId, Kind, Key, Id);
  }
  DeleteMappingById(GuildId: string, Kind: string, Id: string): void {
    this.Db.prepare('DELETE FROM mappings WHERE guild_id=? AND kind=? AND resource_id=?').run(GuildId, Kind, Id);
  }
  GetMappings(GuildId: string, Kind: string): Record<string,string> {
    const Rows = this.Db.prepare('SELECT semantic_key,resource_id FROM mappings WHERE guild_id=? AND kind=? ORDER BY semantic_key').all(GuildId, Kind) as {semantic_key:string,resource_id:string}[];
    return Object.fromEntries(Rows.map(Row => [Row.semantic_key, Row.resource_id]));
  }
  HasActivePlan(GuildId: string, ExceptId?: string): boolean {
    const Row = this.Db.prepare("SELECT id FROM plans WHERE guild_id=? AND status IN ('running','uncertain') AND id != ? LIMIT 1")
      .get(GuildId, ExceptId ?? '') as {id:string} | undefined;
    return Boolean(Row);
  }
  RecordAction(Id:string,GuildId:string,Actor:string,Kind:string,TargetId:string,State:string,ErrorMessage?:string):void {
    this.Db.prepare(`INSERT INTO direct_actions(id,guild_id,actor,kind,target_id,state,error,updated_at,actor_identity)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,error=excluded.error,updated_at=excluded.updated_at`)
      .run(Id,GuildId,Actor,Kind,TargetId,State,ErrorMessage??null,new Date().toISOString(),JSON.stringify(this.GetActor(Actor)??null));
  }
  SaveActor(Actor:ActorIdentity):void {
    this.Db.prepare('INSERT INTO actors(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(Actor.id,JSON.stringify(Actor));
  }
  GetActor(Id:string):ActorIdentity|undefined {
    const Row=this.Db.prepare('SELECT body FROM actors WHERE id=?').get(Id) as {body:string}|undefined;
    return Row?JSON.parse(Row.body) as ActorIdentity:undefined;
  }
  AppendEvent(EventValue:OperationalEvent):void {
    const Safe=NormalizeEvent(EventValue);
    this.Db.prepare('INSERT OR IGNORE INTO events(id,guild_id,type,observed_at,body) VALUES(?,?,?,?,?)')
      .run(Safe.id,Safe.guildId,Safe.type,Safe.observedAt,JSON.stringify(Safe));
  }
  ListEvents(GuildId:string,Limit:number,Cursor?:string,Since?:string,Until?:string):Page<OperationalEvent> {
    const Rows=this.Db.prepare(`SELECT sequence,body FROM events WHERE guild_id=? AND sequence<? AND observed_at>=? AND observed_at<=?
      ORDER BY sequence DESC LIMIT ?`).all(GuildId,Cursor?Number(Cursor):Number.MAX_SAFE_INTEGER,Since??'0000',Until??'9999',Limit+1) as {sequence:number;body:string}[];
    const Items=Rows.slice(0,Limit);
    return {items:Items.map(Row=>JSON.parse(Row.body) as OperationalEvent),nextCursor:Rows.length>Limit?String(Items.at(-1)!.sequence):undefined,
      limit:Limit,source:'local-gateway-events',completeness:'observed-only'};
  }
  PruneEvents(RetentionDays:number,Now=new Date()):number {
    const Cutoff=new Date(Now.getTime()-RetentionDays*86400000).toISOString();
    return this.Db.prepare('DELETE FROM events WHERE observed_at<?').run(Cutoff).changes;
  }
  CreateNotification(Value:OperatorNotification):void {
    this.Db.prepare(`INSERT INTO notifications(id,guild_id,severity,category,title,details,actor_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(Value.id,Value.guildId,Value.severity,Value.category,Value.title,JSON.stringify(Value.details),Value.actorId,Value.createdAt);
  }
  ListNotifications(GuildId:string,Limit:number,Cursor?:string,UnacknowledgedOnly=false):Page<OperatorNotification> {
    const Rows=this.Db.prepare(`SELECT * FROM notifications WHERE guild_id=? AND sequence<? AND (?=0 OR acknowledged_at IS NULL)
      ORDER BY sequence DESC LIMIT ?`).all(GuildId,Cursor?Number(Cursor):Number.MAX_SAFE_INTEGER,UnacknowledgedOnly?1:0,Limit+1) as Record<string,unknown>[];
    const Items=Rows.slice(0,Limit);
    return {items:Items.map(Row=>({id:String(Row.id),guildId:String(Row.guild_id),severity:Row.severity as OperatorNotification['severity'],
      category:String(Row.category),title:String(Row.title),details:JSON.parse(String(Row.details)),actorId:String(Row.actor_id),
      createdAt:String(Row.created_at),acknowledgedAt:Row.acknowledged_at?String(Row.acknowledged_at):undefined,
      acknowledgedBy:Row.acknowledged_by?String(Row.acknowledged_by):undefined})),
      nextCursor:Rows.length>Limit?String(Items.at(-1)!.sequence):undefined,limit:Limit,source:'local-notifications',completeness:'observed-only'};
  }
  AcknowledgeNotification(GuildId:string,Id:string,ActorId:string):boolean {
    return this.Db.prepare(`UPDATE notifications SET acknowledged_at=?,acknowledged_by=? WHERE guild_id=? AND id=? AND acknowledged_at IS NULL`)
      .run(new Date().toISOString(),ActorId,GuildId,Id).changes===1;
  }
  HasUncertainAction(GuildId:string):boolean {
    return Boolean(this.Db.prepare("SELECT id FROM direct_actions WHERE guild_id=? AND state IN ('running','uncertain') LIMIT 1").get(GuildId));
  }
  GetAction(Id:string):{id:string;guild_id:string;actor:string;kind:string;target_id:string;state:string;error:string|null}|undefined {
    return this.Db.prepare('SELECT * FROM direct_actions WHERE id=?').get(Id) as ReturnType<Store['GetAction']>;
  }
  ListUncertainActions(GuildId:string) {
    return this.Db.prepare("SELECT id,guild_id,actor,kind,target_id,state,error,updated_at FROM direct_actions WHERE guild_id=? AND state IN ('running','uncertain') ORDER BY updated_at")
      .all(GuildId);
  }
  ResolveAction(Id:string,Actor:string):void {
    const Action=this.GetAction(Id);
    if (!Action||Action.actor!==Actor||!['running','uncertain'].includes(Action.state)) throw new Error('No uncertain action for this actor');
    this.RecordAction(Id,Action.guild_id,Actor,Action.kind,Action.target_id,'resolved');
  }
  Close(): void { this.Db.close(); }
}
