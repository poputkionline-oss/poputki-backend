const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
process.env.JWT_SECRET='review-route-test-secret-not-production';
const {issueUserToken}=require('../utils/userAuth');
const roleModule=require('../dbServiceRole');
let captured=null;let result={success:true,id:123};let dbFailure=false;
roleModule.getServiceRoleClient=()=>({rpc:async(name,params)=>{captured={name,params};return {data:result,error:dbFailure?{code:'DB_ERROR'}:null};}});
const express=require('express');const app=express();app.use(express.json());app.use('/reviews',require('../routes/reviews'));
let server,origin;
before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin=`http://127.0.0.1:${server.address().port}`;});
after(()=>{server.closeAllConnections();server.close();});
async function post(path,body,token=issueUserToken({id:2})){
 return fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
}
test('unauthenticated users cannot submit bus reviews',async()=>{assert.equal((await post('/reviews/bus',{booking_id:12,rating:5},'invalid')).status,401);});
test('bus submit binds JWT identity and ignores forged recipient and reviewer',async()=>{
 const res=await post('/reviews/bus',{booking_id:12,rating:5,comment:'Good',reviewer_id:999,driver_id:555});assert.equal(res.status,200);
 assert.deepEqual(captured,{name:'fn_submit_verified_review',params:{p_kind:'bus',p_target_id:12,p_reviewer_id:2,p_rating:5,p_comment:'Good'}});
});
test('legacy route remains compatible and ignores spoofed driver',async()=>{
 const res=await post('/reviews',{ride_id:25,rating:4,driver_id:999});assert.equal(res.status,200);assert.equal(captured.params.p_kind,'ride');assert.equal(captured.params.p_reviewer_id,2);
});
test('invalid ratings and malformed comments never reach the DB',async()=>{
 for(const body of [{booking_id:12,rating:6},{booking_id:12,rating:'5'},{booking_id:12,rating:5,comment:[]},{booking_id:0,rating:5},{booking_id:12,rating:5,comment:'x'.repeat(2001)}]){
 captured=null;assert.equal((await post('/reviews/bus',body)).status,400);assert.equal(captured,null);
 }
});
test('duplicates and eligibility rejections return explicit failure, not success',async()=>{
 for(const [error,status] of [['ALREADY_REVIEWED',409],['REVIEW_FORBIDDEN',403],['PASSENGER_NOT_BOARDED',403],['TRIP_NOT_COMPLETED',400]]){
 result={success:false,error};assert.equal((await post('/reviews/bus',{booking_id:12,rating:5})).status,status);
 }result={success:true,id:123};
});
test('database failures are surfaced and do not disclose details',async()=>{
 dbFailure=true;const res=await post('/reviews/bus',{booking_id:12,rating:5});assert.equal(res.status,500);assert.equal((await res.json()).error,'REVIEW_FAILED');dbFailure=false;
});
