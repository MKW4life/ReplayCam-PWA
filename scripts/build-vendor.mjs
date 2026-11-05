import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('vendor',{recursive:true});
await build({stdin:{contents:"export {Input,MP4,WEBM,BlobSource,Output,BufferTarget,Mp4OutputFormat,WebMOutputFormat,EncodedPacketSink,EncodedVideoPacketSource,EncodedAudioPacketSource} from 'mediabunny';",resolveDir:process.cwd()},bundle:true,format:'esm',target:['safari16.4'],minify:true,outfile:'vendor/mediabunny.js',legalComments:'eof',banner:{js:'/*! Mediabunny 1.65.2 | MPL-2.0 | Source: https://registry.npmjs.org/mediabunny/-/mediabunny-1.65.2.tgz | See vendor/NOTICE.md and mediabunny-LICENSE.txt */'}});
await copyFile('node_modules/mediabunny/LICENSE','vendor/mediabunny-LICENSE.txt');
