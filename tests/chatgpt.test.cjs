// OAuth conformance cases adapted from zotero-chatgpt (AGPL-3.0).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const provider = require('../src/vendor/chatgpt-plan.cjs');
const C = provider.constants;
const keys = webcrypto.subtle.generateKey({ name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256' },true,['sign','verify']);
const clone = value => JSON.parse(JSON.stringify(value));

async function jwt(claims, changes={}) {
  const pair=await keys;
  const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'official-test-key',...changes.header})).toString('base64url');
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,Buffer.from(header+'.'+payload));
  return header+'.'+payload+'.'+Buffer.from(signature).toString('base64url');
}
function stream(text, final=true) {
  const events=[{type:'response.created'}];
  for(let i=0;i<text.length;i+=7)events.push({type:'response.output_text.delta',delta:text.slice(i,i+7)});
  if(final)events.push({type:'response.completed',response:{status:'completed',model:'account-model',output:[{type:'message',content:[{type:'output_text',text}]}]}});
  return events.map(event=>'data: '+JSON.stringify(event)+'\r\n\r\n').join('');
}
function harness(options={}) {
  let now=Date.UTC(2026,10,13,8),authURL,resolveCallback,closed=0;
  const prefs=new Map(),records=new Map(),calls=[],settings={...options};
  const store={list:async()=>[...records.values()].map(clone),put:async record=>{if(settings.beforePut)await settings.beforePut(record);records.set(record.client_id,clone(record));}};
  const preferences={get:key=>prefs.get(key),set:(key,value)=>prefs.set(key,value)};
  const json=(value,status=200)=>({status,text:JSON.stringify(value)});
  const request=async req=>{
    calls.push(req);
    if(req.url===C.DISCOVERY)return json({issuer:C.AUTH,jwks_uri:C.JWKS,revocation_endpoint:C.REVOKE});
    if(req.url===C.JWKS){const jwk=await webcrypto.subtle.exportKey('jwk',(await keys).publicKey);return json({keys:[{...jwk,kid:'official-test-key',alg:'RS256',use:'sig'}]});}
    if(req.url===C.TOKEN){
      const form=new URLSearchParams(req.body);
      if(form.get('grant_type')==='refresh_token') {
        if(settings.beforeRefresh)await settings.beforeRefresh();
        if(settings.refreshDelay)await new Promise(r=>setTimeout(r,settings.refreshDelay));
        if(settings.refreshError)return json({error:settings.refreshError},settings.refreshStatus||400);
        if(settings.refreshThrow)throw new Error('network unavailable');
        return json({access_token:'REFRESHED_ACCESS_SECRET',refresh_token:'ROTATED_REFRESH_SECRET',token_type:'Bearer',expires_in:3600,...settings.refreshResponse});
      }
      if(settings.exchangeResponse)return settings.exchangeResponse;
      if(settings.tokenError)return json({error:settings.tokenError},400);
      const clientID=form.get('client_id');
      const claims={iss:C.AUTH,aud:clientID,exp:Math.floor(now/1000)+3600,iat:Math.floor(now/1000),sub:settings.subject||'verified-subject',email:'tester@example.test',nonce:authURL.searchParams.get('nonce'),...settings.claims};
      let token=await jwt(claims,settings.jwtChanges);
      if(settings.tamper)token=token.slice(0,-3)+'aaa';
      return json({access_token:'ACCESS_SECRET',refresh_token:'REFRESH_SECRET',id_token:token,token_type:'Bearer',expires_in:3600,scope:C.SCOPES,...settings.tokenResponse});
    }
    if(req.url===C.REVOKE){if(settings.beforeRevoke)await settings.beforeRevoke();if(settings.revokeThrow)throw new Error('offline');return {status:settings.revokeStatus||200,text:''};}
    if(req.url===C.RESOURCE+'/models'){
      if(settings.modelsStatus)return {
        ...json({error:{code:settings.modelsCode}},settings.modelsStatus),
        requestId:'req_test_models'
      };
      return json({models:[{visibility:'list',slug:'account-model',display_name:'Account Model'},{visibility:'hide',slug:'hidden-model'}]});
    }
    if(req.url===C.RESOURCE+'/responses'){
      const text=settings.generated||'{"tags":["本地文献"],"note":"简记"}';
      const data=settings.streamData===undefined?stream(text,settings.complete!==false):settings.streamData;
      if(settings.responseStatus)return json({error:{code:settings.responseCode||'subscription_sharing_usage_limit_exceeded'}},settings.responseStatus);
      if(settings.beforeStream)await settings.beforeStream(req);
      for(let i=0;i<data.length;i+=11){if(req.signal?.aborted){const error=new Error('cancelled');error.name='AbortError';throw error;}req.onChunk?.(data.slice(i,i+11));}
      return {status:200,text:data};
    }
    throw new Error('Unexpected endpoint');
  };
  const openCallback=({state})=>({redirectUri:settings.redirectUri||'http://127.0.0.1:49152/auth/callback',result:new Promise(resolve=>{resolveCallback=resolve;}),close(){closed++;}});
  const launchURL=async value=>{
    authURL=new URL(value);
    if(settings.onLaunch)await settings.onLaunch(authURL);
    if(settings.deferCallback)return;
    const query=new URLSearchParams({state:settings.badState?'forged-state':authURL.searchParams.get('state'),code:'single-use-code'});
    if(settings.callbackError)query.set('error',settings.callbackError);
    if(!settings.noIssued)query.set('client_id',settings.issuedID||'oaiapp_test_client');
    resolveCallback('http://127.0.0.1:49152/auth/callback?'+query);
  };
  const api=provider.create({crypto:webcrypto,store,preferences,request,openCallback,launchURL,now:()=>now,setTimeout,clearTimeout});
  return {api,calls,records,prefs,settings,auth:()=>authURL,closed:()=>closed,advance:ms=>{now+=ms;},callback:url=>resolveCallback(url)};
}

test('official dynamic OAuth uses PKCE, fresh state/nonce and ephemeral exact loopback callback',async()=>{
  const h=harness();const status=await h.api.login();const url=h.auth();
  assert.equal(url.origin+url.pathname,C.AUTHORIZE);
  assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'),'EndNote ChatGPT');
  assert.equal(url.searchParams.get('redirect_uri'),'http://127.0.0.1:49152/auth/callback');
  assert.equal(url.searchParams.get('resource'),C.RESOURCE);
  assert.match(url.searchParams.get('ext_agent_host_id'),/^urn:uuid:/);
  const exchange=h.calls.find(call=>call.url===C.TOKEN),fields=new URLSearchParams(exchange.body);
  assert.equal(fields.get('client_id'),'oaiapp_test_client');
  assert.equal(fields.get('redirect_uri'),url.searchParams.get('redirect_uri'));
  assert.equal(fields.has('client_secret'),false);
  const digest=await webcrypto.subtle.digest('SHA-256',Buffer.from(fields.get('code_verifier')));
  assert.equal(url.searchParams.get('code_challenge'),Buffer.from(digest).toString('base64url'));
  assert.equal(status.connected,true);
  assert.equal(status.accountId,'oaiapp_test_client');
  assert.ok(h.closed());
  assert.equal(JSON.stringify(status).includes('ACCESS_SECRET'),false);
  assert.equal(JSON.stringify([...h.prefs.values()]).includes('REFRESH_SECRET'),false);
});

test('callback state, issued client and denial are checked before code exchange',async()=>{
  for(const settings of [{badState:true},{noIssued:true},{callbackError:'access_denied'}]){
    const h=harness(settings);
    await assert.rejects(h.api.login());
    assert.equal(h.calls.some(call=>call.url===C.TOKEN),false);
    assert.equal(h.records.size,0);
  }
});

test('real RS256 validation rejects tampering, wrong issuer/audience/nonce/subject and expired tokens',async()=>{
  for(const settings of [{tamper:true},{claims:{iss:'https://attacker.test'}},{claims:{aud:'another-client'}},{claims:{nonce:'wrong'}},{claims:{exp:0}},{claims:{nbf:9999999999}},{jwtChanges:{header:{alg:'none'}}}]){
    const h=harness(settings);
    await assert.rejects(h.api.login(),/身份|签名/);
    assert.equal(h.records.size,0);
  }
  const h=harness();await h.api.login();h.settings.subject='different-user';
  await assert.rejects(h.api.login(),/身份校验/);
  assert.equal(h.records.get('oaiapp_test_client').subject,'verified-subject');
});

test('an identity login without granted plan scopes is never treated as connected',async()=>{
  const h=harness({tokenResponse:{scope:'openid profile email offline_access'}});
  await assert.rejects(h.api.login(),/未授权/);
  assert.equal((await h.api.status()).connected,false);
});

test('returning sign-in preserves issued client, host and validated identity',async()=>{
  const h=harness();await h.api.login();const first=h.auth(),host=first.searchParams.get('ext_agent_host_id'),state=first.searchParams.get('state');
  h.settings.noIssued=true;await h.api.login();
  assert.equal(h.auth().searchParams.get('client_id'),'oaiapp_test_client');
  assert.equal(h.auth().searchParams.has('agent_name_hint'),false);
  assert.equal(h.auth().searchParams.get('ext_agent_host_id'),host);
  assert.notEqual(h.auth().searchParams.get('state'),state);
  assert.equal(h.records.size,1);
  h.settings.noIssued=false;h.settings.issuedID='oaiapp_wrong';
  await assert.rejects(h.api.login(),/不匹配/);
  assert.equal(h.records.size,1);
});

test('multiple account registrations stay separate and can be selected without exposing tokens',async()=>{
  const h=harness();await h.api.login();h.settings.issuedID='oaiapp_second';h.settings.subject='second-subject';
  await h.api.login({newAccount:true});
  assert.equal(h.records.size,2);
  const accounts=await h.api.accounts();assert.equal(accounts.length,2);
  assert.notEqual(accounts[0].label,accounts[1].label);
  assert.equal(JSON.stringify(accounts).includes('ACCESS_SECRET'),false);
  const status=await h.api.selectAccount('oaiapp_test_client');assert.equal(status.accountId,'oaiapp_test_client');
});

test('model picker uses official account catalog visibility and slug fields',async()=>{
  const h=harness();await h.api.login();
  assert.deepEqual(await h.api.listModels(),[{id:'account-model',name:'Account Model'}]);
  const call=h.calls.find(call=>call.url===C.RESOURCE+'/models');
  assert.equal(call.headers.Authorization,'Bearer ACCESS_SECRET');
});

test('explicitly rejected access tokens clear the unusable login without discarding the account mapping',async()=>{
  const h=harness({modelsStatus:401,modelsCode:'invalid_token'});await h.api.login();
  await assert.rejects(h.api.listModels(),{stage:'models',status:401,code:'invalid_token'});
  assert.equal((await h.api.status()).connected,false);
  assert.equal(h.records.get('oaiapp_test_client').subject,'verified-subject');
});

test('a 403 HTML response after browser consent diagnoses code exchange and saves no tokens', async () => {
  const h = harness({ exchangeResponse: {
    status: 403, webpage: true, text: '<html>sample response</html>', requestId: 'req_exchange_test'
  } });
  const steps = [];
  await assert.rejects(h.api.login({ onStep: step => steps.push(step) }), {
    stage: 'exchange', status: 403, webpage: true, requestId: 'req_exchange_test'
  });
  assert.deepEqual(steps, ['browser', 'exchange']);
  assert.equal((await h.api.status()).connected, false);
  assert.equal(h.records.size, 0);
  assert.equal(h.calls.filter(call => call.url === C.TOKEN).length, 1);
});

test('the model directory may fail independently and can be retried without reauthorization', async () => {
  for (const [status, code] of [[403, 'subscription_sharing_user_not_eligible'], [401, 'subscription_sharing_invalid_user']]) {
    const h = harness({ modelsStatus: status, modelsCode: code });
    const steps = [];
    await h.api.login({ onStep: step => steps.push(step) });
    assert.deepEqual(steps, ['browser', 'exchange', 'identity']);
    await assert.rejects(h.api.listModels(), { stage: 'models', status, code, requestId: 'req_test_models' });
    assert.equal((await h.api.status()).connected, true);
    h.settings.modelsStatus = null;
    assert.deepEqual(await h.api.listModels(), [{ id: 'account-model', name: 'Account Model' }]);
    assert.equal(h.calls.filter(call => call.url === C.TOKEN).length, 1);
  }
});

test('streaming Responses sends only supported plan parameters and waits for completion',async()=>{
  const h=harness();await h.api.login();let preview='';
  const result=await h.api.generate({messages:[{role:'system',content:'Return a JSON object.'},{role:'user',content:'A synthetic abstract.'}],model:'account-model',onDelta:delta=>{preview+=delta;}});
  const call=h.calls.find(call=>call.url===C.RESOURCE+'/responses'),body=JSON.parse(call.body);
  assert.deepEqual(Object.keys(body).sort(),['input','instructions','model','store','stream']);
  assert.equal(body.store,false);assert.equal(body.stream,true);
  assert.equal(body.instructions,'Return a JSON object.');assert.equal(body.input[0].role,'user');
  assert.deepEqual(result,{text:'{"tags":["本地文献"],"note":"简记"}',model:'account-model'});
  assert.equal(preview,result.text);
});

test('truncated, failed, incomplete and quota-limited streams never yield success',async()=>{
  const cases=[
    {complete:false},
    {streamData:'data: '+JSON.stringify({type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}})+'\n\n'},
    {streamData:'data: '+JSON.stringify({type:'response.incomplete'})+'\n\n'},
    {responseStatus:429}
  ];
  for(const options of cases){const h=harness(options);await h.api.login();await assert.rejects(h.api.generate({messages:[{role:'user',content:'test'}],model:'account-model'}),/未采用|额度|不完整|限制/);}
});

test('a completion-only SSE frame at EOF is consumed once even when progress already delivered its bytes',async()=>{
  const text='{"note":"一个完整的简记"}';
  const event={type:'response.completed',response:{status:'completed',model:'account-model',output:[{type:'message',content:[{type:'output_text',text}]}]}};
  const h=harness({streamData:'data: '+JSON.stringify(event)});await h.api.login();
  const result=await h.api.generate({messages:[{role:'user',content:'test'}],model:'account-model'});
  assert.equal(result.text,text);
});
