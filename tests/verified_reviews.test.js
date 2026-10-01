const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateReviewInput,ownsBusBooking,eligibleBusBooking}=require('../utils/reviewHelper');
const {processBusReviewInvitations}=require('../utils/busReviewInvitationService');
const booking={id:20,passenger_id:2,status:'confirmed',boarding_status:'boarded',channel:'web',source_type:'platform',bus_tickets:{status:'completed',operator_id:9}};
test('rating is strictly an integer 1..5 and bounded comment',()=>{
 for(const rating of [0,6,2.5,'5',null])assert.equal(validateReviewInput({rating}),false);
 for(const rating of [1,2,3,4,5])assert.equal(validateReviewInput({rating}),true);
 assert.equal(validateReviewInput({rating:5,comment:'a'.repeat(2001)}),false);
 assert.equal(validateReviewInput({rating:5,comment:{}}),false);
});
test('claim is authoritative and unclaimed manual creator cannot review',()=>{
 assert.equal(ownsBusBooking({...booking,claimed_by_user_id:3},2),false);
 assert.equal(ownsBusBooking({...booking,claimed_by_user_id:3,channel:'manual'},3),true);
 assert.equal(ownsBusBooking({...booking,channel:'manual'},2),false);
 assert.equal(ownsBusBooking({...booking,contact_role:'carrier_contact'},2),false);
 assert.equal(ownsBusBooking(booking,8),false);
});
test('only boarded, confirmed and completed trips qualify; self reviews blocked',()=>{
 assert.equal(eligibleBusBooking(booking,2),true);
 for(const state of ['pending_boarding','no_show',null])assert.equal(eligibleBusBooking({...booking,boarding_status:state},2),false);
 assert.equal(eligibleBusBooking({...booking,status:'cancelled'},2),false);
 assert.equal(eligibleBusBooking({...booking,bus_tickets:{status:'active',operator_id:9}},2),false);
 assert.equal(eligibleBusBooking({...booking,bus_tickets:{status:'completed',operator_id:2}},2),false);
});
function mockDb({b=booking,review=null,lookupError=null}={}){
 const updates=[];let claimed=0;
 return {updates,get claimed(){return claimed;},async rpc(){claimed++;return {data:[{id:1,booking_id:20,bus_ticket_id:10,reviewer_id:2}]};},from(table){
  let values=null;const q={select(){return q;},eq(){return q;},single:async()=>table==='users'?{data:{telegram_id:123}}:{data:b,error:lookupError},maybeSingle:async()=>({data:review}),update(v){values=v;return q;},then(resolve){if(values)updates.push(values);resolve(values?{error:null}:{count:1,error:null});}};return q;
 }};
}
test('invitation dry-run does not claim or send',async()=>{
 const db=mockDb();await processBusReviewInvitations({dbClient:db,dryRun:true,send:async()=>assert.fail('send')});assert.equal(db.claimed,0);
});
test('eligibility rechecked before sending; one claimed invitation sent',async()=>{
 const db=mockDb();let sent=0;const r=await processBusReviewInvitations({dbClient:db,send:async()=>{sent++;}});assert.equal(sent,1);assert.equal(r.sent,1);assert.equal(db.updates[0].status,'sent');
});
test('revoked ownership, no-show and existing reviews suppress invitations',async()=>{
 for(const options of [{b:{...booking,claimed_by_user_id:3}},{b:{...booking,boarding_status:'no_show'}},{review:{id:8}}]){
  const db=mockDb(options);const r=await processBusReviewInvitations({dbClient:db,send:async()=>assert.fail('send')});assert.equal(r.skipped,1);
 }
});
test('lookup failures fail closed; ambiguous network outcome is not retried',async()=>{
 const db=mockDb({lookupError:{code:'FAIL'}});const r=await processBusReviewInvitations({dbClient:db,send:async()=>assert.fail('send')});assert.equal(r.failed,1);
 const uncertain=mockDb();const result=await processBusReviewInvitations({dbClient:uncertain,send:async()=>{throw Error('timeout');}});assert.equal(result.uncertain,1);assert.equal(uncertain.updates[0].status,'uncertain');
});
