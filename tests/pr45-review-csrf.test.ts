/**
 * Supplemental credential edge cases absent from the committed PR #45 suite.
 *
 * Provenance: authored by the independent reviewer of PR #45 and now a permanent test so
 * it keeps running in CI. Copied unchanged apart from this note. This file mutates
 * `process.env` at module load, so it MUST run in its own process (see package.json
 * "test:review-pr45") and must not be appended to a shared `node --test` invocation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { getTokenFromRequest } from "@/lib/auth";
import { hasSessionCookie, readSessionCookie } from "@/lib/session-cookie";
import { evaluateCsrfRequestForRequest } from "@/lib/csrf";
import proxy from "@/proxy";

const origin = "https://review.example.test";
const foreign = "https://other.example.test";
function request(headers: Record<string,string> = {}, method = "POST") {
  return new NextRequest(`${origin}/api/quizzes`,{method,headers:{host:"review.example.test",...headers}});
}
// Tests pin the default policy without altering any deployment configuration.
for (const name of ["EASY_LEARN_PUBLIC_ORIGIN","EASY_LEARN_ALLOWED_ORIGINS","EASY_LEARN_TRUST_PROXY_HEADERS"]) delete process.env[name];

for (const [label,cookie,selected] of [
  ["two values; first wins","el_token=first; el_token=second","first"],
  ["empty first value cannot fall through","el_token=; el_token=second",null],
  ["malformed percent encoding first cannot fall through","el_token=%ZZ; el_token=second",null],
  ["malformed last value cannot shadow the first","el_token=first; el_token=%ZZ","first"],
  ["empty cookie","el_token=",null],
  ["encoded cookie","theme=dark; el_token=first%2Esecond","first.second"],
] as const) {
  test(`cookie ambiguity: ${label}`,async()=>{
    assert.equal(readSessionCookie(cookie),selected);
    assert.equal(hasSessionCookie(cookie),true);
    const req=request({cookie,authorization:"Bearer explicit",origin:foreign});
    assert.equal(getTokenFromRequest(req),"explicit");
    assert.equal(evaluateCsrfRequestForRequest(req).allowed,false);
    const response=proxy(req);
    assert.equal(response.status,403);
    assert.equal(response.headers.get("cache-control"),"no-store");
    const payload=await response.text();
    assert.ok(!payload.includes("explicit") && !payload.includes("first%2Esecond"));
  });
}
test("whenever the auth cookie parser selects a token, the CSRF presence parser detects it",()=>{
  for (const prefix of ["","theme=x;","theme=x; ","theme=x;\t", "other_el_token=z; "])
    for (const value of ["signed.token.example","","%ZZ","%20","%3B",'"quoted"']) {
      const cookie=`${prefix}el_token=${value}; other=x`;
      if (readSessionCookie(cookie)) assert.equal(hasSessionCookie(cookie),true,cookie);
    }
  for (const cookie of ["other_el_token=x","el_token_other=x","EL_TOKEN=x","el_token =x","el_token"]) {
    assert.equal(hasSessionCookie(cookie),false);
    assert.equal(readSessionCookie(cookie),null);
  }
});
for (const [label,authorization] of [
  ["lowercase scheme","bearer token"],
  ["uppercase scheme","BEARER token"],
  ["tab separator","Bearer\ttoken"],
  ["empty bearer","Bearer "],
  ["Basic scheme","Basic token"],
  ["multiple schemes","Basic x, Bearer token"],
] as const) {
  test(`malformed or differently cased Authorization plus cookie: ${label}`,()=>{
    const req=request({authorization,cookie:"el_token=cookie-identity",origin:foreign});
    assert.equal(getTokenFromRequest(req),"cookie-identity");
    assert.equal(evaluateCsrfRequestForRequest(req).allowed,false);
    assert.equal(proxy(req).status,403);
  });
}
test("parser mismatch is fail-closed for auth: lowercase/tab bearer without cookie selects no credential",()=>{
  for (const authorization of ["bearer token","BEARER token","Bearer\ttoken"]) {
    const req=request({authorization});
    assert.equal(evaluateCsrfRequestForRequest(req).rule,"bearer");
    assert.equal(getTokenFromRequest(req),null);
  }
});
test("a canonical invalid bearer is selected instead of falling back to the cookie",()=>{
  const req=request({authorization:"Bearer invalid",cookie:"el_token=cookie-identity",origin});
  assert.equal(getTokenFromRequest(req),"invalid");
  assert.equal(evaluateCsrfRequestForRequest(req).rule,"same-origin");
});
for (const [fetchSite,allowed] of [["same-origin",true],["none",true],["same-site",false],["cross-site",false],["invalid",false],["",false]] as const) {
  test(`cookie + bearer with missing Origin and Fetch Metadata=${fetchSite || "absent"}`,()=>{
    const req=request({cookie:"el_token=ambient",authorization:"Bearer explicit",...(fetchSite ? {"sec-fetch-site":fetchSite} : {})});
    const decision=evaluateCsrfRequestForRequest(req);
    assert.equal(decision.allowed,allowed);
    assert.notEqual(decision.rule,"bearer");
    assert.equal(proxy(req).status,allowed ? 200 : 403);
  });
}
test("null/foreign Origin is not overridden by a same-origin Fetch Metadata assertion",()=>{
  for (const hostileOrigin of ["null",foreign,"not an origin"]) {
    const req=request({cookie:"el_token=ambient",authorization:"Bearer explicit",origin:hostileOrigin,"sec-fetch-site":"same-origin"});
    assert.equal(evaluateCsrfRequestForRequest(req).allowed,false);
  }
});
test("forged forwarded host/proto cannot bypass cookie + bearer protection in the default mode",()=>{
  const req=request({cookie:"el_token=ambient",authorization:"Bearer explicit",origin:foreign,"x-forwarded-host":"other.example.test","x-forwarded-proto":"https","sec-fetch-site":"cross-site"});
  assert.equal(proxy(req).status,403);
});
test("configured canonical origin remains exact for cookie + bearer requests",()=>{
  process.env.EASY_LEARN_PUBLIC_ORIGIN=origin;
  try {
    const req=request({cookie:"el_token=ambient",authorization:"Bearer explicit",origin:"http://review.example.test","sec-fetch-site":"same-origin","x-forwarded-host":"review.example.test"});
    assert.equal(proxy(req).status,403);
  } finally { delete process.env.EASY_LEARN_PUBLIC_ORIGIN; }
});
