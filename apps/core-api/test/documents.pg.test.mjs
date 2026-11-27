// DOC-01 synthetic PG16 + real S3-compatible server + TLS synthetic scanner.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { test } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '@tpa/database/migrate';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const pgImage='pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8';
const s3Image='chrislusf/seaweedfs:4.55@sha256:7ca46aeae2f223b37e5d91593c17ab37738eec6df6ab69b48a0487f7643342b9';
function docker(...args){try{return execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:150000}).trim();}catch{throw new Error(`Synthetic Docker ${args[0]} failed (details suppressed)`);}}
function listen(server){return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));}
function close(server){return server ? new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}) : undefined;}
test('DOC-01 PG16/S3/scanner: PT01/PT15/PT17/PT22 scoped synthetic integration',async t=>{
  const suffix=randomBytes(6).toString('hex'), names=[], password=randomBytes(24).toString('hex');
  const scratch=await mkdtemp(join(tmpdir(),'doc01-'));let admin,proxy,scanner;
  try{
    const pgName=`doc01-pg-${suffix}`;
    docker('run','-d','--name',pgName,'--label',`ao.session=${process.env.AO_SESSION_ID??pgName}`,'--memory','384m','--cpus','1',
      '--tmpfs','/var/lib/postgresql/data:rw,size=512m','-p','127.0.0.1::5432','-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_DB=tpa',pgImage);names.push(pgName);
    const pgPort=docker('port',pgName,'5432/tcp').split(':').at(-1), url=user=>`postgresql://${user}:${password}@127.0.0.1:${pgPort}/tpa`;
    const deadline=Date.now()+45000;
    while(!admin){const c=new pg.Client({connectionString:url('postgres'),connectionTimeoutMillis:2000});try{await c.connect();admin=c;}catch{await c.end().catch(()=>{});if(Date.now()>deadline)throw new Error('PG16 readiness timeout');await delay(250);}}
    await admin.query(await readFile(`${root}infra/migrations/bootstrap.sql`,'utf8'));
    for(const role of ['tpa_app','tpa_migrator']){const {rows:[r]}=await admin.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql",[role,password]);await admin.query(r.sql);}
    await migrateDatabase(url('tpa_migrator'));
    const s3Name=`doc01-s3-${suffix}`;
    docker('run','-d','--name',s3Name,'--label',`ao.session=${process.env.AO_SESSION_ID??s3Name}`,'--memory','384m','--cpus','1','-p','127.0.0.1::8333','-e',`S3_ACCESS_KEY=${suffix}`,'-e',`S3_SECRET_KEY=${password}`,
      '--entrypoint','/bin/sh',s3Image,'-ec',`printf '{"identities":[{"name":"synthetic","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' "$S3_ACCESS_KEY" "$S3_SECRET_KEY" > /tmp/s3.json; exec weed server -dir=/tmp -ip=127.0.0.1 -s3 -s3.config=/tmp/s3.json -volume.max=4 -master.volumeSizeLimitMB=128 -master.telemetry=false`);names.push(s3Name);
    const s3Port=docker('port',s3Name,'8333/tcp').split(':').at(-1);
    const ready=Date.now()+45000;
    for(;;){try{const r=await fetch(`http://127.0.0.1:${s3Port}/`,{signal:AbortSignal.timeout(2000)});if(r.status)break;}catch{}if(Date.now()>ready)throw new Error('S3 readiness timeout');await delay(250);}
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',join(scratch,'key.pem'),'-out',join(scratch,'cert.pem'),'-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    const tls={key:await readFile(join(scratch,'key.pem')),cert:await readFile(join(scratch,'cert.pem'))};
    proxy=createServer(tls,(req,res)=>{const upstream=request({hostname:'127.0.0.1',port:s3Port,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(503);res.end();});req.pipe(upstream);});
    const proxyPort=await listen(proxy);
    scanner=createServer(tls,async(req,res)=>{
      if(req.headers.authorization!==`Bearer ${password}`){res.writeHead(401);res.end();return;}
      const chunks=[];let length=0;for await(const c of req){length+=c.length;if(length>20971520){res.writeHead(413);res.end();return;}chunks.push(c);}
      const b=Buffer.concat(chunks),{createHash}=await import('node:crypto');
      if(b.includes(Buffer.from('OUTAGE'))){res.writeHead(503);res.end();return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify({sha256:createHash('sha256').update(b).digest('hex'),contentType:req.headers['x-document-content-type'],
        malwareFree:!b.includes(Buffer.from('EICAR')),structurallySafe:!b.includes(Buffer.from('POLYGLOT'))&&!b.includes(Buffer.from('BOMB')),scannerVersion:'synthetic-fixture-v1'}));
    });
    const scannerPort=await listen(scanner);
    const child=spawn(process.execPath,['test/fixtures/documents.scenario.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,NODE_EXTRA_CA_CERTS:join(scratch,'cert.pem'),
      DOC_ADMIN_URL:url('postgres'),DOC_APP_URL:url('tpa_app'),DOC_S3_ENDPOINT:`https://127.0.0.1:${proxyPort}`,DOC_S3_ACCESS:suffix,DOC_SECRET:password,DOC_SCANNER_URL:`https://127.0.0.1:${scannerPort}/scan`},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
    const timer=setTimeout(()=>child.kill('SIGKILL'),130000);
    const [code]=await once(child,'exit');clearTimeout(timer);
    // Only synthetic values exist in this fixture; bounded output aids exact failure diagnosis.
    if(code!==0)t.diagnostic(output.slice(-7000));assert.equal(code,0,'DOC-01 scenario must execute every assertion');
    t.diagnostic(output.slice(-3000));
  }finally{await close(proxy);await close(scanner);await admin?.end();for(const n of names.reverse())docker('rm','-f',n);await rm(scratch,{recursive:true,force:true});}
});
