import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {S3Client,CreateBucketCommand,PutBucketVersioningCommand,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {createTenantDatabase} from '@tpa/database/tenant';
import {IdentityStore} from '../../src/identity-tenant/identity-store.ts';
import {OidcVerifier,identityHash} from '../../src/identity-tenant/oidc-verifier.ts';
import {workflowRuntime} from '../../src/workflow-definition/workflow-runtime.ts';
import {DocumentsStore,scanNext} from '../../src/documents-consents/documents.store.ts';
import {S3DocumentStorage} from '../../src/documents-consents/storage.ts';
import {HttpDocumentScanner} from '../../src/documents-consents/scanner.ts';
import {syntheticIssuer} from './synthetic-issuer.ts';
const e=process.env,admin=new pg.Client({connectionString:e.DOC_ADMIN_URL});await admin.connect();
const client=new S3Client({endpoint:e.DOC_S3_ENDPOINT,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:e.DOC_S3_ACCESS,secretAccessKey:e.DOC_SECRET},requestHandler:{requestTimeout:10000}});
const bucket='synthetic-private-documents',storage=new S3DocumentStorage(client,bucket),runtime=await workflowRuntime();
const db=createTenantDatabase({connectionString:e.DOC_APP_URL,max:2});let issuer,identity;
try{
  await client.send(new CreateBucketCommand({Bucket:bucket}));await client.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Enabled'}}));
  issuer=await syntheticIssuer();identity=await IdentityStore.connect(e.DOC_APP_URL,randomBytes(32));
  const verifier=new OidcVerifier(issuer.profile),T=randomUUID(),T2=randomUUID(),principal=randomUUID(),other=randomUUID(),membership=randomUUID(),otherMembership=randomUUID(),crossMembership=randomUUID(),member=randomUUID(),otherMember=randomUUID();
  const policyHash='a'.repeat(64),purpose='SYNTHETIC_DOCUMENT_PROCESSING';
  await admin.query(`INSERT INTO tpa.identity_principals(id,identity_hash) VALUES($1,$2),($3,$4)`,[principal,identityHash(issuer.profile.issuer,'alice'),other,identityHash(issuer.profile.issuer,'bob')]);
  await admin.query(`INSERT INTO tpa.identity_memberships(tenant_id,id,principal_id,roles) VALUES($1,$2,$3,ARRAY['MEMBER']),($1,$4,$5,ARRAY['MEMBER']),($6,$7,$3,ARRAY['MEMBER'])`,[T,membership,principal,otherMembership,other,T2,crossMembership]);
  for(const [tenant,m,p,subject] of [[T,membership,principal,member],[T,otherMembership,other,otherMember],[T2,crossMembership,principal,member]]){
    await admin.query('INSERT INTO tpa.identity_membership_directory(tenant_id,membership_id,principal_id) VALUES($1,$2,$3)',[tenant,m,p]);
    await admin.query(`INSERT INTO tpa.identity_member_grants(tenant_id,membership_id,member_id,relation) VALUES($1,$2,$3,'SELF')`,[tenant,m,subject]);
    await admin.query(`INSERT INTO tpa.consent_policies(tenant_id,purpose,policy_version,policy_hash) VALUES($1,$2,'v1',$3) ON CONFLICT DO NOTHING`,[tenant,purpose,policyHash]);
  }
  const alice=await verifier.verifyAuthorization(`Bearer ${await issuer.token('alice')}`),bob=await verifier.verifyAuthorization(`Bearer ${await issuer.token('bob')}`);
  const select=async(i,m)=> (await identity.select(i,m,randomUUID())).view.contextToken;
  const a={identity:alice,membershipContext:await select(alice,membership)},b={identity:bob,membershipContext:await select(bob,otherMembership)},cross={identity:alice,membershipContext:await select(alice,crossMembership)};
  const call=(base=a,key=randomUUID())=>({...base,idempotencyKey:key});
  const api=new DocumentsStore(identity,runtime,storage,purpose),scanner=new HttpDocumentScanner(new URL(e.DOC_SCANNER_URL),e.DOC_SECRET),service=randomUUID();
  const consentBody={memberId:member,purpose,policyVersion:'v1',policyHash,accepted:true};
  const payload=Buffer.from('%PDF-1.7\nSYNTHETIC_PII_DOCUMENT_MARKER\n%%EOF');
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const request=(bytes=payload,overrides={})=>({memberId:member,fileName:'SYNTHETIC_PII_FILENAME.pdf',contentType:'application/pdf',docType:'INVOICE_PHOTO',sizeBytes:bytes.length,sha256:hash(bytes),...overrides});
  const rejected={status:422,code:'DOMAIN_VIOLATION'},hidden={status:404,code:'NOT_FOUND'},conflict={status:409,code:'IDEMPOTENCY_CONFLICT'};
  await assert.rejects(api.presign(call(),request()),rejected);
  await assert.rejects(api.consent(call(),{...consentBody,policyHash:'b'.repeat(64)}),rejected);
  await assert.rejects(api.consent(call(b),consentBody),hidden);
  const cc=call(),consent=await api.consent(cc,consentBody);assert.deepEqual((await api.consent(cc,consentBody)).body,consent.body);
  await assert.rejects(api.consent(cc,{...consentBody,policyVersion:'v2'}),rejected);
  const pc=call(),grant=(await api.presign(pc,request())).body,replay=(await api.presign(pc,request())).body;
  assert.deepEqual(replay,grant,'presign replay reproduces original URL/body and expiry');
  await assert.rejects(api.presign(pc,request(payload,{fileName:'changed.pdf'})),conflict);
  for(const overrides of [{sizeBytes:20971521},{contentType:'application/x-msdownload'},{objectKey:'other'},{fileName:'../private.pdf'}])await assert.rejects(api.presign(call(),request(payload,overrides)),{status:422,code:'VALIDATION_FAILED'});
  const completeBody={sha256:hash(payload),sizeBytes:payload.length};
  await assert.rejects(api.complete(call(b),grant.uploadId,completeBody),hidden);
  await assert.rejects(api.complete(call(cross),grant.uploadId,completeBody),hidden);
  assert.equal((await fetch(grant.uploadUrl)).status,403,'signed PUT cannot become public GET');
  const put=async(g,bytes,headers={})=>fetch(g.uploadUrl,{method:'PUT',headers:{...g.requiredHeaders,...headers,'Content-Length':String(bytes.length)},body:bytes});
  assert.ok((await put(grant,payload)).ok,'direct S3 PUT must succeed');
  await assert.rejects(api.complete(call(),grant.uploadId,{...completeBody,sizeBytes:1}),rejected);
  assert.equal((await put(grant,payload,{'Content-Type':'image/png'})).ok,false,'signed type cannot change');
  assert.equal((await put(grant,Buffer.from('wrong checksum'))).ok,false,'signed size cannot change');
  assert.equal((await put(grant,Buffer.alloc(payload.length))).ok,false,'signed checksum cannot change even at the same size');
  const expired=randomUUID();
  await admin.query(`INSERT INTO tpa.upload_sessions(tenant_id,id,member_id,principal_id,membership_id,consent_id,object_key,content_type,doc_type,size_bytes,sha256,created_at,expires_at) SELECT tenant_id,$1,member_id,principal_id,membership_id,consent_id,$2,content_type,doc_type,size_bytes,sha256,clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '9 minutes' FROM tpa.upload_sessions WHERE id=$3`,[expired,`quarantine/expired/${expired}`,grant.uploadId]);
  await assert.rejects(api.complete(call(),expired,completeBody),conflict);
  const completionCall=call(),doc=(await api.complete(completionCall,grant.uploadId,completeBody)).body;
  assert.equal(doc.scanStatus,'QUARANTINED');
  await assert.rejects(api.consume(a,doc.documentId,()=>assert.fail('quarantine consumed')),rejected);
  await assert.rejects(db.withTenantTransaction(T,tx=>scanNext(tx,{...runtime,appendAudit:async()=>{throw new Error('synthetic audit outage');}},storage,scanner,service)));
  assert.equal((await api.get(a,doc.documentId)).scanStatus,'QUARANTINED','scan audit failure rolls back state/outbox');
  assert.equal(await db.withTenantTransaction(T,tx=>scanNext(tx,runtime,storage,scanner,service)),true);
  assert.equal((await api.get(a,doc.documentId)).scanStatus,'CLEAN');
  assert.deepEqual((await api.complete(completionCall,grant.uploadId,completeBody)).body,doc,'replay returns original QUARANTINED response');
  await assert.rejects(api.complete(completionCall,grant.uploadId,{...completeBody,sha256:'c'.repeat(64)}),conflict);
  await assert.rejects(api.get(b,doc.documentId),hidden);await assert.rejects(api.get(cross,doc.documentId),hidden);
  let consumed=false;await api.consume(a,doc.documentId,async(tx,o,v)=>{const r=await client.send(new GetObjectCommand({Bucket:bucket,Key:o.key,VersionId:v}));assert.equal(Buffer.from(await r.Body.transformToByteArray()).toString(),payload.toString());consumed=true;});assert.ok(consumed);
  // Privileged fixture tampers latest; consumers remain pinned to the verified original version.
  const {rows:[upload]}=await admin.query('SELECT object_key FROM tpa.upload_sessions WHERE id=$1',[grant.uploadId]);
  await client.send(new PutObjectCommand({Bucket:bucket,Key:upload.object_key,Body:Buffer.from('MZ changed'),ContentType:'application/pdf'}));
  await api.consume(a,doc.documentId,async(_tx,o,v)=>assert.deepEqual(Buffer.from(await storage.read(o,v)),payload));
  const create=async bytes=>{const g=(await api.presign(call(),request(bytes))).body;assert.ok((await put(g,bytes)).ok);return {g,body:{sha256:hash(bytes),sizeBytes:bytes.length}};};
  const concurrent=await create(Buffer.from('%PDF-1.7\nconcurrent\n%%EOF'));
  const pair=await Promise.all([api.complete(call(),concurrent.g.uploadId,concurrent.body),api.complete(call(),concurrent.g.uploadId,concurrent.body)]);
  assert.equal(pair[0].body.documentId,pair[1].body.documentId,'different-key concurrent completion creates one document');
  await db.withTenantTransaction(T,tx=>scanNext(tx,runtime,storage,scanner,service));
  for(const marker of ['EICAR','POLYGLOT','BOMB']){
    const {g,body}=await create(Buffer.from(`%PDF-1.7\n${marker}\n%%EOF`)),d=(await api.complete(call(),g.uploadId,body)).body;
    await db.withTenantTransaction(T,tx=>scanNext(tx,runtime,storage,scanner,service));assert.equal((await api.get(a,d.documentId)).scanStatus,'REJECTED');
    await assert.rejects(api.consume(a,d.documentId,()=>assert.fail('attack consumed')),rejected);
  }
  const attack=await create(Buffer.from('MZ executable'));await assert.rejects(api.complete(call(),attack.g.uploadId,attack.body),rejected);
  // Wrong object metadata/size/checksum cannot pass even when privileged upload bypasses signature.
  for(const [actualType,actualBytes] of [['image/png',payload],['application/pdf',Buffer.alloc(20971521)],['application/pdf',Buffer.alloc(payload.length)]]){
    const mismatch=(await api.presign(call(),request())).body;
    const key=(await admin.query('SELECT object_key FROM tpa.upload_sessions WHERE id=$1',[mismatch.uploadId])).rows[0].object_key;
    await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:actualBytes,ContentType:actualType,ChecksumSHA256:Buffer.from(hash(actualBytes),'hex').toString('base64')}));
    assert.equal((await fetch(`${e.DOC_S3_ENDPOINT}/${bucket}/${key}`)).status,403,'anonymous object reads are private');
    await assert.rejects(api.complete(call(),mismatch.uploadId,completeBody),rejected);
  }
  const outage=await create(Buffer.from('%PDF-1.7\nOUTAGE\n%%EOF')),pending=(await api.complete(call(),outage.g.uploadId,outage.body)).body;
  await assert.rejects(db.withTenantTransaction(T,tx=>scanNext(tx,runtime,storage,scanner,service)));
  assert.equal((await api.get(a,pending.documentId)).scanStatus,'QUARANTINED');
  // Immutable evidence, app permissions, tenant RLS and transaction-local reuse.
  await assert.rejects(db.withTenantTransaction(T,tx=>tx.query('DELETE FROM tpa.document_versions')),{code:'42501'});
  assert.equal((await db.withTenantTransaction(T2,tx=>tx.query('SELECT * FROM tpa.document_versions'))).rows.length,0);
  await assert.rejects(db.withTenantTransaction(T2,tx=>tx.query(`INSERT INTO tpa.document_scan_outbox(tenant_id,document_id) VALUES($1,$2)`,[T2,doc.documentId])),{code:'23503'});
  const {rows:[evidence]}=await admin.query(`SELECT (SELECT json_agg(a) FROM tpa.audit_logs a WHERE tenant_id=$1) AS audit,(SELECT json_agg(i) FROM tpa.idempotency_records i WHERE tenant_id=$1) AS operations`,[T]);
  assert.doesNotMatch(JSON.stringify(evidence),/SYNTHETIC_PII|X-Amz-Signature|https:\/\//);
  assert.ok(evidence.audit.some(r=>r.action==='DOCUMENT_CONTENT_ACCESS'));assert.ok(evidence.audit.some(r=>r.action==='DOCUMENT_SCANNED'));
  await admin.query('UPDATE tpa.consent_policies SET active=false WHERE tenant_id=$1',[T]);
  assert.equal(await db.withTenantTransaction(T,tx=>scanNext(tx,runtime,storage,{scan:async()=>assert.fail('revoked policy reached scanner')},service)),false);
  await assert.rejects(api.consume(a,doc.documentId,()=>assert.fail('revoked consent consumed')),rejected);
  // Authorization is revalidated on a replay; revoked relation never receives old URL/response.
  await admin.query('UPDATE tpa.identity_member_grants SET active=false WHERE tenant_id=$1 AND membership_id=$2',[T,membership]);
  await assert.rejects(api.complete(completionCall,grant.uploadId,completeBody),hidden);
  console.log('PASS DOC-01 synthetic PG16/private S3/TLS scanner: consent policy/owner, direct PUT, pinned version, quarantine/CLEAN/malware/unsafe/outage, tenant RLS/FK, replay/conflict/revocation, minimal audit evidence.');
}finally{await identity?.close();await issuer?.close();await db.close();client.destroy();await admin.end();}
