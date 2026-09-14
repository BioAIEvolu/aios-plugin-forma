import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export const inject = ['webServer', 'tools', 'appReady'];
export const Config = z.object({ token: z.string().required() });

/** Disposable-profile consumer used only by the local aios-plugin-forma test. */
export function apply(ctx, config) {
  const authorized = req => req.headers.authorization === `Bearer ${config.token}` && !req.headers.origin;
  const respond = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const names = () => ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('forma_'));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/forma/plugin/health', handler: (req, res) => {
    if (!authorized(req)) return respond(res, 403, { error: 'FORBIDDEN' });
    respond(res, 200, { tools: names(), sameCordis: ctx === Context });
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/forma/plugin/call', handler: async (req, res) => {
    if (!authorized(req)) return respond(res, 403, { error: 'FORBIDDEN' });
    if (req.method !== 'POST') return respond(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    let body = '';
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) return respond(res, 413, { error: 'BODY_TOO_LARGE' }); }
      const input = JSON.parse(body);
      if (typeof input.name !== 'string' || !names().includes(input.name)) return respond(res, 400, { error: 'TOOL_NOT_ALLOWED' });
      const result = await ctx.tools.execute({ callId: 'forma-plugin-test', name: input.name, arguments: input.arguments ?? {}, signal: controller.signal });
      respond(res, 200, result);
    } catch (error) { if (!res.destroyed) respond(res, 400, { error: error.message }); }
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/forma/plugin/shutdown', handler: (req, res) => {
    if (!authorized(req)) return respond(res, 403, { error: 'FORBIDDEN' });
    respond(res, 200, { stopping: true });
    setImmediate(() => process.emit('SIGINT'));
  } }));
  ctx.effect(() => ctx.appReady.onReady(() => process.stdout.write('FORMA_PLUGIN_READY ' + JSON.stringify({ origin: `http://${ctx.webServer.host}:${ctx.webServer.port}` }) + '\n')));
}
