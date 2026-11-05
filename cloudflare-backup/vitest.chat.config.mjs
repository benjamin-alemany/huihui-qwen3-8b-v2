import {cloudflareTest} from "@cloudflare/vitest-plugin";
import {defineConfig} from "vitest/config";
// Simulator-only dummy values. The deployable Wrangler config stays disabled
// and has no authentication, session binding or inference secret configured.
export default defineConfig({plugins:[cloudflareTest({wrangler:{configPath:"./wrangler.chat.jsonc"},miniflare:{workers:[{
  name:'unjailed-chat-controller',modules:true,compatibilityDate:'2026-10-30',
  script:`import {WorkerEntrypoint} from 'cloudflare:workers'; export class OwnerReadiness extends WorkerEntrypoint {status(){return {launchEnabled:false,agentToolsEnabled:false,readiness:{phase:'not-checked'}};}check(){return {launchEnabled:false,agentToolsEnabled:false,readiness:{phase:'pending'}};}quote(){return {launchEnabled:false};}start(){return {error:'LAUNCH_LOCKED',status:409};}stop(){return {error:'SESSION_CHANGED',status:409};}}export class ChatInference extends WorkerEntrypoint {context(){return null;}} export default {fetch(){return new Response('Not found',{status:404});}};`
}],bindings:{
  ACCESS_ISSUER:"https://unjailed-dummy-test.cloudflareaccess.com",ACCESS_AUD:"dummy-chat-audience",OWNER_EMAIL:"owner@example.test",
  CHAT_ENABLED:"true",CHAT_SESSION:JSON.stringify({podId:"abcdefghijklm",createdAt:new Date(Date.now()-1000).toISOString(),nonce:"b".repeat(32),minutes:30}),
  HISTORY_ENABLED:"true",
  SESSION_CONTROLLER_ENABLED:'false',
  INFERENCE_API_KEY:"DUMMY_"+"x".repeat(43)
}}})],test:{include:["chat/test/*.spec.mjs"]}});
