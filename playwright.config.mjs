import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'tests',testMatch:'browser.spec.mjs',workers:1,timeout:60000,
  use:{baseURL:'http://127.0.0.1:8137',viewport:{width:390,height:844},
    launchOptions:{executablePath:process.env.REPLAYCAM_BROWSER||'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']},
    permissions:['camera','microphone'],trace:'retain-on-failure'},
  webServer:{command:'python -m http.server 8137 --bind 127.0.0.1',url:'http://127.0.0.1:8137',reuseExistingServer:false}
});
