import {configuration} from './config.ts';
import {Runtime} from './runtime.ts';
const runtime=new Runtime(configuration().dataRoot);
if(process.argv[2]==='up'){await runtime.up();console.log('M0.5 preview running on loopback 8092; original boundaries unchanged');}
else if(process.argv[2]==='down'){await runtime.down();console.log('M1 runtime stopped');}
else console.log(JSON.stringify(await runtime.check()));
