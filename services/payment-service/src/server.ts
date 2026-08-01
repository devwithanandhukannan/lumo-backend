import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { pool } from '@lumo/database';
import { authenticateToken, AppError, errorHandler, AuthenticatedRequest } from '@lumo/common';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5008;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_T7vwejiBDVEZv1';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'TSKG9X2v9JFJnVsW8Ha1HMt0';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
}));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Payment Service (Razorpay Enabled)' }));

// 1. Create Razorpay Order (Stage 1 Platform Fee OR Stage 2 Remaining Balance)
app.post('/api/v1/payments/create-order', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { bookingId, stage } = req.body; // stage: 'PLATFORM_FEE' | 'BALANCE'
    if (!bookingId || !stage) throw new AppError('bookingId and stage required', 400);

    const bRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (bRes.rowCount === 0) throw new AppError('Booking not found', 404);
    const booking = bRes.rows[0];

    let amount = 0;
    let notesType = '';

    if (stage === 'PLATFORM_FEE') {
      amount = Math.round(parseFloat(booking.platform_fee || '50.00') * 100); // Amount in paise
      notesType = 'LUMO Service Platform Fee';
    } else if (stage === 'BALANCE') {
      amount = Math.round(parseFloat(booking.balance_amount || booking.total_amount || '0') * 100);
      notesType = 'LUMO Professional Service Balance';
    } else {
      throw new AppError('Invalid payment stage. Use PLATFORM_FEE or BALANCE.', 400);
    }

    if (amount <= 0) amount = 5000; // Default ₹50 minimum in paise if uncalculated

    const options = {
      amount,
      currency: 'INR',
      receipt: `rcpt_${bookingId}_${stage.toLowerCase()}`,
      notes: {
        bookingId,
        stage,
        type: notesType,
        customerId: req.user!.userId,
      },
    };

    const order = await razorpay.orders.create(options);

    // Save order ID to database
    if (stage === 'PLATFORM_FEE') {
      await pool.query('UPDATE bookings SET razorpay_platform_order_id = $1 WHERE id = $2', [order.id, bookingId]);
    } else {
      await pool.query('UPDATE bookings SET razorpay_balance_order_id = $1 WHERE id = $2', [order.id, bookingId]);
    }

    console.log(`💳 [RAZORPAY-ORDER] Created Order "${order.id}" for Booking "${bookingId}" (${stage}: ₹${(amount / 100).toFixed(2)})`);

    res.json({
      success: true,
      data: {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: RAZORPAY_KEY_ID,
        stage,
        bookingId,
      },
    });
  } catch (err) { next(err); }
});

// 2. Verify Stage 1 Platform Fee Payment
app.post('/api/v1/payments/verify-platform-fee', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    if (!bookingId || !razorpayPaymentId) {
      throw new AppError('bookingId and razorpayPaymentId are required', 400);
    }

    // Verify HMAC signature if signature provided
    if (razorpayOrderId && razorpaySignature) {
      const generatedSignature = crypto
        .createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      if (generatedSignature !== razorpaySignature) {
        console.warn('⚠️ Invalid Razorpay signature provided for platform fee payment');
      }
    }

    const bRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (bRes.rowCount === 0) throw new AppError('Booking not found', 404);

    const updateRes = await pool.query(
      `UPDATE bookings
       SET platform_fee_paid = true,
           platform_fee_paid_at = NOW(),
           razorpay_platform_payment_id = $1,
           status = 'CONFIRMED',
           payment_status = 'PLATFORM_FEE_PAID',
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [razorpayPaymentId, bookingId]
    );

    console.log(`✅ [STAGE-1-PAID] Customer paid Platform Fee for Booking "${bookingId}" (Payment ID: ${razorpayPaymentId})`);

    res.json({
      success: true,
      message: 'Platform Fee paid successfully! Booking is now CONFIRMED.',
      data: updateRes.rows[0],
    });
  } catch (err) { next(err); }
});

// 3. Verify Stage 2 Balance Payment (Job End)
app.post('/api/v1/payments/verify-balance', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    if (!bookingId || !razorpayPaymentId) {
      throw new AppError('bookingId and razorpayPaymentId are required', 400);
    }

    // Verify HMAC signature if signature provided
    if (razorpayOrderId && razorpaySignature) {
      const generatedSignature = crypto
        .createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      if (generatedSignature !== razorpaySignature) {
        console.warn('⚠️ Invalid Razorpay signature provided for balance payment');
      }
    }

    const bRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (bRes.rowCount === 0) throw new AppError('Booking not found', 404);
    const booking = bRes.rows[0];

    const updateRes = await pool.query(
      `UPDATE bookings
       SET balance_paid = true,
           balance_paid_at = NOW(),
           razorpay_balance_payment_id = $1,
           status = 'COMPLETED',
           payment_status = 'FULLY_PAID',
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [razorpayPaymentId, bookingId]
    );

    // Release professional busy status & record job completion
    if (booking.pro_id) {
      await pool.query(
        `UPDATE professional_profiles
         SET is_busy = false, total_jobs_completed = total_jobs_completed + 1, updated_at = NOW()
         WHERE user_id = $1`,
        [booking.pro_id]
      );
    }

    console.log(`🎉 [STAGE-2-PAID] Customer paid final balance for Booking "${bookingId}" (Payment ID: ${razorpayPaymentId}). Professional price credited!`);

    res.json({
      success: true,
      message: 'Job balance paid successfully! Booking COMPLETED & earnings credited to Professional.',
      data: updateRes.rows[0],
    });
  } catch (err) { next(err); }
});

// 4. Razorpay Webhook Callback Handler
app.post('/api/v1/payments/razorpay-webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'] as string;
    const bodyStr = JSON.stringify(req.body);

    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(bodyStr)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.warn('⚠️ Razorpay webhook signature mismatch');
    }

    const event = req.body?.event;
    const payload = req.body?.payload?.payment?.entity;

    if (event === 'payment.captured' && payload) {
      const notes = payload.notes || {};
      const bookingId = notes.bookingId;
      const stage = notes.stage;

      if (bookingId && stage === 'PLATFORM_FEE') {
        await pool.query(
          `UPDATE bookings SET platform_fee_paid = true, platform_fee_paid_at = NOW(), status = 'CONFIRMED', payment_status = 'PLATFORM_FEE_PAID' WHERE id = $1`,
          [bookingId]
        );
      } else if (bookingId && stage === 'BALANCE') {
        await pool.query(
          `UPDATE bookings SET balance_paid = true, balance_paid_at = NOW(), status = 'COMPLETED', payment_status = 'FULLY_PAID' WHERE id = $1`,
          [bookingId]
        );
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error' });
  }
});

// 5. Booking Payment Summary Endpoint
app.get('/api/v1/payments/booking/:id/summary', async (req, res, next) => {
  try {
    const { id } = req.params;
    const bRes = await pool.query(
      `SELECT b.*, s.name as service_name
       FROM bookings b
       LEFT JOIN services s ON b.service_id = s.id
       WHERE b.id = $1`,
      [id]
    );

    if (bRes.rowCount === 0) throw new AppError('Booking not found', 404);
    const b = bRes.rows[0];

    res.json({
      success: true,
      data: {
        bookingId: b.id,
        serviceName: b.service_name,
        baseAmount: parseFloat(b.base_amount || '0'),
        travelCharge: parseFloat(b.travel_charge || '0'),
        platformFee: parseFloat(b.platform_fee || '50'),
        platformFeePaid: Boolean(b.platform_fee_paid),
        balanceAmount: parseFloat(b.balance_amount || '0'),
        balancePaid: Boolean(b.balance_paid),
        totalAmount: parseFloat(b.total_amount || '0'),
        paymentStatus: b.payment_status || 'UNPAID',
        status: b.status,
      },
    });
  } catch (err) { next(err); }
});

// 6. Razorpay Asynchronous Webhook Endpoint
app.post('/api/v1/payments/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'] as string;
    const bodyStr = JSON.stringify(req.body);

    if (signature) {
      const expectedSignature = crypto
        .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
        .update(bodyStr)
        .digest('hex');

      if (signature !== expectedSignature) {
        console.warn('⚠️ [RAZORPAY-WEBHOOK] Invalid HMAC Signature received');
        return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
      }
    }

    const { event, payload } = req.body;
    console.log(`🔔 [RAZORPAY-WEBHOOK] Received event: ${event}`);

    if (event === 'payment.captured' || event === 'order.paid') {
      const entity = payload?.payment?.entity || payload?.order?.entity;
      const notes = entity?.notes || {};
      const bookingId = notes.bookingId;

      if (bookingId) {
        if (notes.stage === 'PLATFORM_FEE') {
          await pool.query(
            `UPDATE bookings SET platform_fee_paid = true, platform_fee_paid_at = NOW(), payment_status = 'PARTIALLY_PAID', status = 'CONFIRMED' WHERE id = $1`,
            [bookingId]
          );
        } else if (notes.stage === 'BALANCE') {
          await pool.query(
            `UPDATE bookings SET balance_paid = true, balance_paid_at = NOW(), payment_status = 'PAID' WHERE id = $1`,
            [bookingId]
          );
        }
      }
    }

    res.json({ success: true, received: true });
  } catch (err: any) {
    console.error('❌ [RAZORPAY-WEBHOOK] Error handling webhook:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`💳 Payment Service running with Razorpay on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

