import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
const hash = s => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const assets = { '/': ['index.html','text/html; charset=utf-8'], '/explorer.js': ['explorer.js','text/javascript; charset=utf-8'], '/app.js': ['app.js','text/javascript; charset=utf-8'], '/style.css': ['style.css','text/css; charset=utf-8'] };
export function createApp({ data, map, origin, clientId, clientSecret, fetchImpl = fetch, demo = false, now = () => Date.now() }) {
  const sessions = new Map(), flows = new Map();
  const cookies = req => Object.fromEntries((req.headers.cookie ?? '').split(';').map(s => s.trim().split('=')));
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${demo ? '' : '; Secure'}`;
  const redirectUri = `${origin}/auth/callback`;
  function send(res, status, value) { if(res.authPage && status>=400){res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登入專案導覽</title><link rel="stylesheet" href="/style.css"><main><section class="login"><h1>暫時無法登入</h1><p>${value.error}</p><a class="button" href="/auth/login">重新登入</a></section></main></html>`);return;} res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  function redirect(res, url, setCookie) { res.writeHead(302, { Location: url, ...(setCookie ? { 'Set-Cookie':setCookie } : {}) }); res.end(); }
  function clean() { for (const cache of [sessions, flows]) for (const [k,v] of cache) if(v.expires <= now()) cache.delete(k); }
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    clean();
    try {
      const u = new URL(req.url, origin), c = cookies(req);
      res.authPage = u.pathname === '/auth/callback';
      if (!['GET','POST'].includes(req.method)) return send(res,405,{error:'不支援此操作'});
      if (req.method === 'POST') {
        if (u.pathname !== '/auth/logout') return send(res,405,{error:'此介面唯讀'});
        if (req.headers.origin !== origin) return send(res,403,{error:'來源無效'});
        sessions.delete(hash(c.hub_session ?? ''));
        res.setHeader('Set-Cookie',cookie('hub_session','',0));
        return send(res,200,{ok:true});
      }
      if (u.pathname === '/auth/login') {
        if (demo) return redirect(res,'/');
        if (flows.size >= 500) return send(res,429,{error:'請稍後再試'});
        const state = random(); flows.set(hash(state),{expires:now()+300_000});
        const url = new URL('https://discord.com/oauth2/authorize');
        url.search = new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'identify',state});
        return redirect(res,url.href,cookie('hub_oauth',state,300));
      }
      if (u.pathname === '/auth/callback') {
        const state=u.searchParams.get('state'), flow=state && flows.get(hash(state));
        if (u.searchParams.has('error')) return redirect(res,'/?login=cancelled',cookie('hub_oauth','',0));
        if (!flow || c.hub_oauth !== state || !u.searchParams.get('code') || (u.searchParams.has('iss') && u.searchParams.get('iss') !== 'https://discord.com')) return send(res,400,{error:'登入已失效，請重新登入'});
        flows.delete(hash(state));
        const tokenRes = await fetchImpl('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'authorization_code',code:u.searchParams.get('code'),redirect_uri:redirectUri}),signal:AbortSignal.timeout(8000)});
        if (!tokenRes.ok) return send(res,502,{error:'Discord 登入暫時失敗'});
        const token=await tokenRes.json();
        const userRes=await fetchImpl('https://discord.com/api/v10/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(8000)});
        if (!userRes.ok) return send(res,502,{error:'Discord 身分無法確認'});
        const user=await userRes.json(), member=await data.member(user.id);
        if (!member) return send(res,403,{error:'你還不是此專案的有效成員，請聯絡專案負責人'});
        if (sessions.size >= 500) return send(res,429,{error:'請稍後再試'});
        const sid=random(); sessions.set(hash(sid),{discordId:user.id,expires:now()+4*3600_000});
        return redirect(res,'/',[cookie('hub_session',sid,4*3600),cookie('hub_oauth','',0)]);
      }
      if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (assets[u.pathname]) {
        const [file,type]=assets[u.pathname];
        res.setHeader('Content-Type',type);
        return res.end(await readFile(new URL(`../public/${file}`,import.meta.url)));
      }
      if (u.pathname.startsWith('/api/')) {
        const s=sessions.get(hash(c.hub_session ?? ''));
        const member=demo ? {display_name:'示範使用者',group_id:'group-a'} : s && await data.member(s.discordId);
        if (!member) return send(res,401,{error:'請先登入；若資格已撤銷請聯絡負責人'});
        if (u.pathname === '/api/me') return send(res,200,{name:member.display_name,demo});
        if (u.pathname === '/api/architecture') return send(res,200,{...map,symbols:Object.fromEntries(Object.entries(map.symbols??{}).map(([id,{code,...meta}])=>[id,meta]))});
        const codeMatch=u.pathname.match(/^\/api\/code\/(.+)$/);
        if(codeMatch){let id;try{id=decodeURIComponent(codeMatch[1]);}catch{return send(res,400,{error:'無效的函式識別'});}
          const code=Object.hasOwn(map.symbols??{},id)?map.symbols[id]:null;return send(res,code?200:404,code?{...code,snapshot:map.codeSnapshot}:{error:'函式不在本組快照白名單中'});}
        const snapshot=await data.snapshot(member.group_id);
        if (u.pathname === '/api/overview') return send(res,200,snapshot);
        const match=u.pathname.match(/^\/api\/items\/(\d+)$/);
        if (match) { const item=snapshot.items.find(i=>i.id===match[1]); return send(res,item?200:404,item??{error:'紀錄不在最近查詢範圍內'}); }
      }
      return send(res,404,{error:'找不到此頁面'});
    } catch { send(res,503,{error:'資料暫時無法取得，請稍後重試'}); }
  });
}
