'use strict';
const {getServiceRoleClient}=require('../dbServiceRole');
const {eligibleBusBooking}=require('./reviewHelper');

async function sendInvitation(telegramId,bookingId){
    if(!process.env.TELEGRAM_BOT_TOKEN)throw new Error('BOT_NOT_CONFIGURED');
    const axios=require('axios');
    const origin=new URL(process.env.MINI_APP_URL || 'https://www.poputki.online').origin;
    const {data}=await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
        chat_id:telegramId,text:'Поездка завершена. Оцените перевозчика и расскажите, как прошёл автобусный рейс.',
        reply_markup:{inline_keyboard:[[{text:'Оставить отзыв',web_app:{url:`${origin}/my-bus-tickets?reviewBookingId=${bookingId}`}}]]}
    },{timeout:10000});
    if(!data?.ok)throw new Error('TELEGRAM_REJECTED');
}
async function processBusReviewInvitations({dbClient=null,send=sendInvitation,limit=5,dryRun=false}={}){
    const db=dbClient || getServiceRoleClient();
    if(dryRun){
        const {count,error}=await db.from('bus_review_invitations').select('id',{count:'exact',head:true}).eq('status','pending');
        if(error)throw error;return {pending:count || 0,sent:0,dry_run:true};
    }
    const {data:rows,error}=await db.rpc('fn_claim_bus_review_invitations',{p_limit:Math.min(5,Math.max(1,limit))});
    if(error)throw error;
    const counts={sent:0,skipped:0,failed:0,uncertain:0};
    for(const row of rows || []){
        let status='skipped',lastError=null;
        // Fail closed on any lookup error; never send to a stale/changed owner.
        try{
            const {data:b,error:bErr}=await db.from('bus_ticket_bookings').select('*,bus_tickets!inner(status,operator_id)').eq('id',row.booking_id).single();
            if(bErr)throw bErr;
            const {data:review,error:rErr}=await db.from('reviews').select('id').eq('bus_ticket_id',row.bus_ticket_id).eq('reviewer_id',row.reviewer_id).maybeSingle();
            if(rErr)throw rErr;
            const {data:user,error:uErr}=await db.from('users').select('telegram_id').eq('id',row.reviewer_id).single();
            if(uErr)throw uErr;
            if(eligibleBusBooking(b,row.reviewer_id) && !review && user?.telegram_id){
                status='uncertain'; // network ambiguity must never trigger automatic resend
                await send(user.telegram_id,row.booking_id);
                status='sent';
            }
        }catch(err){
            if(status!=='uncertain')status='failed';
            lastError=status==='uncertain'?'DELIVERY_UNCONFIRMED':'LOOKUP_FAILED';
        }
        const {error:updateError}=await db.from('bus_review_invitations').update({status,last_error:lastError,lease_expires_at:null,sent_at:status==='sent'?new Date().toISOString():null}).eq('id',row.id).eq('status','processing');
        if(updateError)throw updateError;
        counts[status]++;
    }
    return counts;
}
module.exports={processBusReviewInvitations};
