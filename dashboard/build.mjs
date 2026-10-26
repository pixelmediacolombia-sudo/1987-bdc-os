import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {copyFileSync} from 'node:fs';
const root=path.dirname(fileURLToPath(import.meta.url));
await build({configFile:false,root:path.join(root,'client'),base:'/mi-dia/',plugins:[react()],build:{outDir:path.join(root,'public'),emptyOutDir:true,sourcemap:false}});
copyFileSync(path.join(root,'client/bridge.js'),path.join(root,'public/bridge.js'));
await build({configFile:false,root,publicDir:false,build:{outDir:path.join(root,'compiled'),emptyOutDir:true,minify:false,lib:{entry:path.join(root,'server/router.mjs'),formats:['cjs'],fileName:()=> 'router.cjs'},rollupOptions:{external:['express','node:path','node:crypto']}}});
