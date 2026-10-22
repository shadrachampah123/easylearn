/** Probe the actual Next production proxy, not just an imported proxy function.
 *
 * Provenance: authored by the independent reviewer of PR #45 and now a permanent test.
 * NOT part of required CI: it needs a built app served by `next start`, which the quality
 * job does not do. Run it deliberately with `npm run test:review-pr45-http`.
 * Start the reviewed build locally on port 3015, with a disposable/unused DB URL.
 * Only invalid synthetic credentials are used: 401 proves the request reached auth;
 * 403 proves it was rejected by the CSRF proxy before auth.
 */
const assert=require('node:assert/strict');
const http=require('node:http');
const {test}=require('node:test');
const localPort=Number(process.env.PR45_REVIEW_PORT || 3015);
function post(headers={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:localPort,path:'/api/quizzes',method:'POST',headers:{host:'review.example.test','content-type':'application/json',...headers}},res=>{
      let body=''; res.setEncoding('utf8'); res.on('data',chunk=>body+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });
    req.on('error',reject); req.end('{}');
  });
}
const cookie='el_token=invalid-cookie';
const bearer='Bearer invalid-bearer';
for (const [name,headers,status] of [
  ['foreign cookie+bearer',{cookie,authorization:bearer,origin:'http://foreign.example.test'},403],
  ['same-origin cookie+bearer',{cookie,authorization:bearer,origin:'http://review.example.test'},401],
  ['missing metadata cookie+bearer',{cookie,authorization:bearer},403],
  ['missing Origin cross-site metadata',{cookie,authorization:bearer,'sec-fetch-site':'cross-site'},403],
  ['missing Origin same-site metadata',{cookie,authorization:bearer,'sec-fetch-site':'same-site'},403],
  ['missing Origin same-origin metadata',{cookie,authorization:bearer,'sec-fetch-site':'same-origin'},401],
  ['missing Origin none metadata',{cookie,authorization:bearer,'sec-fetch-site':'none'},401],
  ['duplicate cookie first empty',{cookie:'el_token=; el_token=second',authorization:bearer,origin:'http://foreign.example.test'},403],
  ['duplicate Cookie header fields',{cookie:['el_token=%ZZ','el_token=second'],authorization:bearer,origin:'http://foreign.example.test'},403],
  ['lowercase bearer with cookie',{cookie,authorization:'bearer invalid',origin:'http://foreign.example.test'},403],
  ['tab-separated bearer with cookie',{cookie,authorization:'Bearer\tinvalid',origin:'http://foreign.example.test'},403],
  ['empty bearer with cookie',{cookie,authorization:'Bearer ',origin:'http://foreign.example.test'},403],
  ['canonical bearer only',{authorization:bearer},401],
  ['lowercase bearer only',{authorization:'bearer invalid'},401],
  ['tab-separated bearer only',{authorization:'Bearer\tinvalid'},401],
  ['empty bearer only',{authorization:'Bearer '},403],
  ['null Origin and claimed same-origin',{cookie,authorization:bearer,origin:'null','sec-fetch-site':'same-origin'},403],
  ['forged forwarding headers do not change foreign host',{cookie,authorization:bearer,origin:'http://foreign.example.test','x-forwarded-host':'foreign.example.test','x-forwarded-proto':'http'},403],
  ['derived-scheme legitimate same-origin metadata',{cookie,authorization:bearer,origin:'http://review.example.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin'},401],
  ['derived-scheme correction not granted to cross-site metadata',{cookie,authorization:bearer,origin:'http://review.example.test','x-forwarded-proto':'https','sec-fetch-site':'cross-site'},403],
]) {
  test(`real HTTP: ${name}`,async()=>{
    const result=await post(headers);
    assert.equal(result.status,status,result.body);
    assert.ok(!result.body.includes('invalid-cookie')&&!result.body.includes('invalid-bearer'));
    if (status===403) assert.equal(result.headers['cache-control'],'no-store');
  });
}
