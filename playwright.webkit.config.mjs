import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests',outputDir:'test-results-webkit',testMatch:'storage-webkit.spec.mjs',workers:1,timeout:60000,use:{browserName:'webkit',baseURL:'http://127.0.0.1:8138'},webServer:{command:'python -m http.server 8138 --bind 127.0.0.1',url:'http://127.0.0.1:8138',reuseExistingServer:false}});
