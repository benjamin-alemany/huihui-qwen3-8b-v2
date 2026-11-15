import {cloudflareTest} from '@cloudflare/vitest-plugin';import {defineConfig} from 'vitest/config';
import {denyOutbound} from './chat/test/deny-outbound.mjs';
export default defineConfig({plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.chat-stop-primary.jsonc'},miniflare:{outboundService:denyOutbound,bindings:{RUNPOD_API_KEY:'',GUARD_ARM_ENABLED:'true'}}})],test:{setupFiles:['./chat/test/offline.mjs'],include:['chat/controller/test/guard.spec.mjs']}});
