import {jwtVerify,createRemoteJWKSet} from "jose";
let remoteKeys,remoteIssuer;
export async function authenticate(request,env) {
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUD || !env.OWNER_EMAIL) return false;
  const issuer=env.ACCESS_ISSUER;
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)) return false;
  const token=request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  if (remoteIssuer!==issuer) {
    remoteKeys=createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));remoteIssuer=issuer;
  }
  try { return await verifyOwner(token,remoteKeys,env); } catch { return false; }
}
export async function verifyOwner(token,keys,env) {
  const {payload}=await jwtVerify(token,keys,{issuer:env.ACCESS_ISSUER,audience:env.ACCESS_AUD,
    algorithms:["RS256"],requiredClaims:["exp","iat","sub","email"],maxTokenAge:"24h"});
  return payload.email===env.OWNER_EMAIL;
}
