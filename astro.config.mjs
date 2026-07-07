// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
    site: 'https://geochina.co',
    integrations: [mdx(), sitemap(), react()],
    // 站点整体仍是静态输出；仅 /api/scan 等标记 prerender=false 的路由走服务端
    adapter: vercel(),
});