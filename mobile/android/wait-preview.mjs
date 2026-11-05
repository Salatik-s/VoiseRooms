import http from 'node:http';
const deadline=Date.now()+60000;
while(true){
 try{await new Promise((resolve,reject)=>{const request=http.get('http://127.0.0.1:5200/?preview=call',response=>{response.resume();response.statusCode===200?resolve():reject(Error('Preview not ready'));});request.on('error',reject);request.setTimeout(2000,()=>request.destroy(Error('Preview timeout')));});break;}
 catch(error){if(Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,500));}
}
console.log('Android visual fixture ready on port5200');
