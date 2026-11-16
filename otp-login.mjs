// Public login UI. Recipient and encryption secrets are never configured here.
export function initialiseOtp({endpoint,onUnlocked,documentRoot=document,fetcher=fetch,random=crypto}){
 const root=documentRoot,$=id=>root.getElementById(id);let challenge=null,nonce='',generation=0,cooldown=null;
 const parsed=new URL(endpoint);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('Invalid login endpoint.');
 const api=async(action,data)=>{const r=await fetcher(endpoint.replace(/\/$/,'')+'/'+action,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();if(!r.ok)throw new Error(action==='request'?'A code could not be sent. Please wait and try again.':'The code could not be verified. Please try again.');return value;};
 const reset=()=>{generation++;challenge=null;nonce='';clearInterval(cooldown);cooldown=null;$('otp-code').value='';$('otp-form').hidden=true;$('send-code').disabled=false;$('send-code').textContent='Send code';$('verify-code').disabled=false;$('otp-status').textContent='';$('unlock-error').textContent='';};
 $('send-code').onclick=async()=>{
  const attempt=++generation;$('send-code').disabled=true;$('unlock-error').textContent='';nonce=Array.from(random.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  try{const result=await api('request',{nonce});if(attempt!==generation)return;if(!/^[0-9a-f-]{36}$/.test(result.requestId||''))throw new Error('Cannot start sign-in.');challenge=result.requestId;$('otp-form').hidden=false;$('otp-status').textContent='Check your inbox for a one-time code.';let seconds=60;$('send-code').textContent='Send again in '+seconds+'s';clearInterval(cooldown);cooldown=setInterval(()=>{seconds--;$('send-code').textContent=seconds>0?'Send again in '+seconds+'s':'Send another code';if(seconds<=0){clearInterval(cooldown);cooldown=null;$('send-code').disabled=false;}},1000);}catch(error){if(attempt===generation){$('unlock-error').textContent=error.message;$('send-code').disabled=false;$('send-code').textContent='Send code';}}
 };
 $('otp-form').onsubmit=async event=>{
  event.preventDefault();if(!challenge)return;const attempt=generation;let code=$('otp-code').value.trim();$('otp-code').value='';if(!/^\d{8}$/.test(code)){$('unlock-error').textContent='Enter the eight-digit code from your email.';return;}$('verify-code').disabled=true;$('unlock-error').textContent='';
  try{const result=await api('verify',{requestId:challenge,nonce,code});code='';if(attempt!==generation)return;if(typeof result.unlockSecret!=='string'||result.unlockSecret.length<16)throw new Error('Could not open your records.');let secret=result.unlockSecret;delete result.unlockSecret;await onUnlocked(secret);secret='';if(attempt===generation)reset();}catch(error){if(attempt===generation){$('unlock-error').textContent=error.message;$('verify-code').disabled=false;}}finally{code='';}
 };
 return {reset};
}
