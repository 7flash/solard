import {SolardConnection} from '../connection.ts';
import {confirmSignature} from '../../tx/confirm.ts';

const owner=new SolardConnection(process.argv[2], 'confirmed', {rpcUrls:process.argv.slice(2)});
const connection=owner.get();
const signature='3Gu7UUD3hmk966VZuB88y2dLReziBPcAdDTnsA9rKuTawtnYYVK9PSC1yyrwdnB6HTSFwewJDuG7LWNDbb6QRGmX';
try{
 const result=await confirmSignature(connection,signature,'rpc',Number(process.env.FIXTURE_CONFIRM_TIMEOUT_MS??2000));
 console.log(JSON.stringify(result));
}finally{
 owner.close();
}
