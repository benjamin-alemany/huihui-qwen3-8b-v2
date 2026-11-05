import {cloudflareTest} from '@cloudflare/vitest-plugin';import {defineConfig} from 'vitest/config';
export default defineConfig({plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.chat-stop-primary.jsonc'},miniflare:{bindings:{GUARD_ARM_ENABLED:'true'}}})],test:{include:['chat/controller/test/guard.spec.mjs']}});
