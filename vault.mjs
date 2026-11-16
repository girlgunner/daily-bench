// Shared Node/browser encryption. The password and plaintext never enter published assets.
const encoder=new TextEncoder(),decoder=new TextDecoder();
const aad=encoder.encode('daily-workbench-vault:v1');
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
function bytes(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function key(password,salt,iterations){
 const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function seal(value,password){
 if(typeof password!=='string'||password.length<16)throw new Error('Use a strong password with at least 16 characters.');
 const salt=crypto.getRandomValues(new Uint8Array(32)),iv=crypto.getRandomValues(new Uint8Array(12)),iterations=600000;
 const compressed=await new Response(new Blob([encoder.encode(JSON.stringify(value))]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},await key(password,salt,iterations),compressed);
 return {format:'daily-workbench-vault',version:1,kdf:'PBKDF2-SHA256',compression:'gzip',iterations,salt:base64(salt),iv:base64(iv),ciphertext:base64(new Uint8Array(encrypted))};
}
export async function unseal(envelope,password){
 if(envelope?.format!=='daily-workbench-vault'||envelope.version!==1||envelope.compression!=='gzip'||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==600000||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>12*1024*1024)throw new Error('Unsupported encrypted workbench.');
 const salt=bytes(envelope.salt),iv=bytes(envelope.iv);if(salt.length!==32||iv.length!==12)throw new Error('Invalid encrypted workbench.');
 try{const compressed=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},await key(password,salt,envelope.iterations),bytes(envelope.ciphertext));const plaintext=await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text();if(plaintext.length>16*1024*1024)throw new Error('Records are too large.');return JSON.parse(plaintext);}catch{throw new Error('The password is incorrect or the encrypted file has changed.');}
}
