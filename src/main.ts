import { resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DiscordAdapter } from './discord.js';
import { ControlPlane } from './control.js';
import { Store } from './store.js';
import { BuildMcpServer } from './interface.js';
import { CreateHttpServer } from './http.js';

const DiscordToken=process.env.DISCORD_BOT_TOKEN;
if (!DiscordToken) throw new Error('DISCORD_BOT_TOKEN is required');
const Stdio=process.argv.includes('--stdio');
const ApiToken=process.env.CONTROL_API_TOKEN;
if (!Stdio && (!ApiToken||ApiToken.length<24)) throw new Error('CONTROL_API_TOKEN must be at least 24 characters for HTTP mode');
const Actor=process.env.CONTROL_ACTOR??'local-operator';
const DbPath=resolve(process.env.CONTROL_DB_PATH??'./data/control.db');
const StoreValue=new Store(DbPath);
const DiscordValue=new DiscordAdapter(DiscordToken);
await DiscordValue.Start();
const Control=new ControlPlane(DiscordValue,StoreValue);
let CloseHttp:(()=>Promise<void>)|undefined;
let Closing=false;
async function Shutdown():Promise<void> {
  if (Closing) return;
  Closing=true;
  if (CloseHttp) await CloseHttp();
  DiscordValue.Stop();
  StoreValue.Close();
}
for (const Signal of ['SIGINT','SIGTERM'] as const)
  process.once(Signal,()=>{void Shutdown().then(()=>process.exit(0),Cause=>{
    process.stderr.write(`[DiscordControl:Shutdown] ${Cause instanceof Error?Cause.message:String(Cause)}\n`);
    process.exit(1);
  });});

if (Stdio) {
  await serveStdio(()=>BuildMcpServer(Control,Actor));
  await Shutdown();
} else {
  const Host=process.env.CONTROL_HOST??'127.0.0.1';
  if (Host!=='127.0.0.1'&&Host!=='::1') throw new Error('HTTP mode currently supports loopback binding only');
  const Port=Number(process.env.CONTROL_PORT??8787);
  const Http=CreateHttpServer(Control,ApiToken!,Actor);
  CloseHttp=Http.close;
  Http.server.listen(Port,Host,()=>process.stderr.write(`[DiscordControl:HTTP] Listening on ${Host}:${Port}\n`));
}
