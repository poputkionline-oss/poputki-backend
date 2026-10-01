const express = require('express');
const router = express.Router();
const { getServiceRoleClient } = require('../dbServiceRole');
const { userAuth } = require('../utils/userAuth');
const { validateReviewInput,eligibleBusBooking,reviewErrors } = require('../utils/reviewHelper');

function submitReview(kind) {
    return async (req,res) => {
        const target=Number(kind==='bus'?req.body.booking_id:req.body.ride_id);
        if (!Number.isSafeInteger(target) || target<1 || !validateReviewInput(req.body)) {
            return res.status(400).json({error:'INVALID_REVIEW',message:reviewErrors.INVALID_REVIEW[1]});
        }
        try {
            const {data,error}=await getServiceRoleClient().rpc('fn_submit_verified_review',{
                p_kind:kind,p_target_id:target,p_reviewer_id:req.user.id,p_rating:req.body.rating,p_comment:req.body.comment || ''
            });
            if(error) throw error;
            if(!data?.success){
                const [status,message]=reviewErrors[data?.error] || [500,'Не удалось сохранить отзыв'];
                return res.status(status).json({error:data?.error || 'REVIEW_FAILED',message});
            }
            return res.json(data);
        } catch(err){console.error('[Reviews] submit failed:',err.code || 'DB_ERROR');return res.status(500).json({error:'REVIEW_FAILED',message:'Не удалось сохранить отзыв. Повторите позже.'});}
    };
}
router.post('/',userAuth,submitReview('ride'));
router.post('/bus',userAuth,submitReview('bus'));
router.get('/mine',userAuth,async(req,res)=>{
    try{
        const {data,error}=await getServiceRoleClient().from('reviews').select('id,ride_id,bus_ticket_id,rating').eq('reviewer_id',req.user.id);
        if(error)throw error;res.json(data || []);
    }catch(err){res.status(500).json({error:'REVIEWS_UNAVAILABLE'});}
});
router.get('/bus/eligible',userAuth,async(req,res)=>{
    try{
        const db=getServiceRoleClient();
        const {data:bookings,error}=await db.from('bus_ticket_bookings')
            .select('id,bus_ticket_id,passenger_id,claimed_by_user_id,channel,source_type,contact_role,status,boarding_status,bus_tickets!inner(status,operator_id)')
            .or(`passenger_id.eq.${req.user.id},claimed_by_user_id.eq.${req.user.id}`)
            .eq('status','confirmed').eq('boarding_status','boarded').eq('bus_tickets.status','completed');
        if(error)throw error;
        const {data:reviews,error:rErr}=await db.from('reviews').select('id,bus_ticket_id').eq('reviewer_id',req.user.id).not('bus_ticket_id','is',null);
        if(rErr)throw rErr;
        res.json((bookings || []).filter(b=>eligibleBusBooking(b,req.user.id)).map(b=>{
            const review=(reviews || []).find(r=>r.bus_ticket_id===b.bus_ticket_id);
            return {booking_id:b.id,bus_ticket_id:b.bus_ticket_id,can_review:!review,review_id:review?.id || null};
        }));
    }catch(err){res.status(500).json({error:'REVIEWS_UNAVAILABLE'});}
});
// Public carrier reputation projection: no phone, passport, booking or reviewer ID.
router.get('/carrier/:id',async(req,res)=>{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'INVALID_CARRIER'});
    try{
        const {data,error}=await getServiceRoleClient().from('reviews')
            .select('id,rating,comment,created_at,users:reviewer_id(name),bus_tickets:bus_ticket_id(from_city,to_city)')
            .eq('driver_id',id).not('bus_ticket_id','is',null).order('created_at',{ascending:false}).limit(100);
        if(error)throw error;
        const rows=data || [];
        const { data: summary, error: summaryError } = await getServiceRoleClient().rpc('fn_carrier_bus_review_summary', { p_carrier_id: id });
        if(summaryError) throw summaryError;
        res.json({...summary,
            reviews:rows.slice(0,100).map(r=>({id:r.id,rating:r.rating,comment:r.comment,created_at:r.created_at,
                reviewer_name:r.users?.name || 'Пассажир',from_city:r.bus_tickets?.from_city,to_city:r.bus_tickets?.to_city}))});
    }catch(err){res.status(500).json({error:'REVIEWS_UNAVAILABLE'});}
});
module.exports=router;
