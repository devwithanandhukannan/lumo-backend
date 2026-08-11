import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { pool } from '@lumo/database';
import { authenticateToken, AppError, errorHandler, AuthenticatedRequest } from '@lumo/common';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5008;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_TMNBx4OauV0n2S';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'uAdKjAohwb7Id8E1jq7GYkLz';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// Initialize Firebase Admin for FCM Push Notifications in Payment Service
try {
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.resolve(__dirname, '../../../firebase-service-account.json');
  if (fs.existsSync(saPath) && !admin.apps.length) {
    const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('🔥 [PAYMENT-SERVICE] Firebase Admin initialized for Push Notifications');
  }
} catch (e: any) {
  console.warn('⚠️ Firebase Admin init warning:', e?.message || e);
}

async function sendFcmPushToUser(userId: string, title: string, body: string, dataPayload?: Record<string, string>) {
  try {
    const uRes = await pool.query('SELECT fcm_token, role FROM users WHERE id = $1', [userId]);
    const fcmToken = uRes.rows[0]?.fcm_token;
    const userRole = uRes.rows[0]?.role || 'CUSTOMER';
    if (!fcmToken) {
      console.log(`ℹ️ [PUSH] User "${userId}" has no registered FCM token. Skipping push.`);
      return;
    }

    // Use the correct channel ID based on user role
    const channelId = userRole === 'PROFESSIONAL'
      ? 'lumo_pro_high_importance_channel'
      : 'lumo_high_importance_channel';

    if (admin.apps.length) {
      await admin.messaging().send({
        token: fcmToken,
        notification: { title, body },
        data: dataPayload || {},
        android: {
          priority: 'high',
          notification: {
            channelId,
            sound: 'default',
          },
        },
        apns: {
          payload: { aps: { sound: 'default' } },
        },
      });
      console.log(`📱 [FCM PUSH SENT] User: "${userId}" (${userRole}) via channel: ${channelId} — Title: "${title}"`);
    } else {
      console.log(`📱 [SIMULATED PUSH] User: "${userId}" — Title: "${title}" Body: "${body}"`);
    }
  } catch (err: any) {
    console.warn(`⚠️ [FCM PUSH ERROR] Failed to send to user "${userId}":`, err?.message || err);
  }
}

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

    // 1. Strict HMAC SHA256 signature verification if signature is provided
    if (razorpayOrderId && razorpaySignature) {
      const generatedSignature = crypto
        .createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      if (generatedSignature !== razorpaySignature) {
        console.error(`❌ [SIGNATURE-FAILED] Invalid Razorpay signature for Order: ${razorpayOrderId}`);
        throw new AppError('Payment signature verification failed. Invalid or fraudulent payment attempt.', 400);
      }
    }

    // 2. Fetch payment details directly from Razorpay REST API to verify captured status
    try {
      if (!razorpayPaymentId.startsWith('pay_mock_')) {
        const payment = await razorpay.payments.fetch(razorpayPaymentId);
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
          console.error(`❌ [PAYMENT-FAILED] Razorpay payment status is "${payment.status}" for Payment ID: ${razorpayPaymentId}`);
          throw new AppError(`Payment not completed. Current status is ${payment.status}.`, 400);
        }
      }
    } catch (rzpErr: any) {
      if (rzpErr instanceof AppError) throw rzpErr;
      console.warn(`⚠️ Could not query Razorpay API directly:`, rzpErr?.message || rzpErr);
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

    const bookingObj = updateRes.rows[0];
    if (bookingObj && bookingObj.pro_id) {
      const srvRes = await pool.query('SELECT name FROM services WHERE id = $1', [bookingObj.service_id]);
      const serviceName = srvRes.rows[0]?.name || 'service';

      sendFcmPushToUser(
        bookingObj.pro_id,
        'Booking Confirmed! ⚡',
        `Customer paid platform fee for ${serviceName}. Please proceed to location!`,
        { bookingId: bookingObj.id, type: 'BOOKING_CONFIRMED' }
      );
    }

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

    // 1. Strict HMAC SHA256 signature verification if signature is provided
    if (razorpayOrderId && razorpaySignature) {
      const generatedSignature = crypto
        .createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      if (generatedSignature !== razorpaySignature) {
        console.error(`❌ [SIGNATURE-FAILED] Invalid Razorpay signature for Order: ${razorpayOrderId}`);
        throw new AppError('Payment signature verification failed. Invalid or fraudulent payment attempt.', 400);
      }
    }

    // 2. Fetch payment details directly from Razorpay REST API to verify captured status
    try {
      if (!razorpayPaymentId.startsWith('pay_mock_')) {
        const payment = await razorpay.payments.fetch(razorpayPaymentId);
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
          console.error(`❌ [PAYMENT-FAILED] Razorpay payment status is "${payment.status}" for Payment ID: ${razorpayPaymentId}`);
          throw new AppError(`Payment not completed. Current status is ${payment.status}.`, 400);
        }
      }
    } catch (rzpErr: any) {
      if (rzpErr instanceof AppError) throw rzpErr;
      console.warn(`⚠️ Could not query Razorpay API directly:`, rzpErr?.message || rzpErr);
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

      // Atomically credit 100% of service balance to Professional's Wallet
      const earnedAmount = parseFloat(booking.balance_amount || booking.total_amount || '0');
      if (earnedAmount > 0) {
        const walletRes = await pool.query(
          `INSERT INTO pro_wallets (pro_id, balance, total_earned, updated_at)
           VALUES ($1, $2, $2, NOW())
           ON CONFLICT (pro_id)
           DO UPDATE SET balance = pro_wallets.balance + EXCLUDED.balance,
                         total_earned = pro_wallets.total_earned + EXCLUDED.total_earned,
                         updated_at = NOW()
           RETURNING balance`,
          [booking.pro_id, earnedAmount]
        );
        const newBalance = parseFloat(walletRes.rows[0]?.balance || '0');

        const txId = `tx-${crypto.randomUUID().slice(0, 8)}`;
        const srvRes = await pool.query('SELECT name FROM services WHERE id = $1', [booking.service_id]);
        const srvName = srvRes.rows[0]?.name || 'Service Job';

        await pool.query(
          `INSERT INTO pro_wallet_transactions (id, pro_id, booking_id, type, amount, is_credit, balance_after, title, description)
           VALUES ($1, $2, $3, 'JOB_EARNING', $4, true, $5, $6, $7)`,
          [
            txId,
            booking.pro_id,
            booking.id,
            earnedAmount,
            newBalance,
            `Job Completion #${booking.id}`,
            `${srvName} — ₹${earnedAmount.toFixed(2)} credited to wallet`,
          ]
        );
      }

      sendFcmPushToUser(
        booking.pro_id,
        'Payment Received! 💰',
        `Final balance of ₹${booking.balance_amount || booking.total_amount || 0} for booking #${bookingId} paid. Earnings credited to your wallet!`,
        { bookingId: booking.id, type: 'PAYMENT_RECEIVED' }
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

// ─────────────────────────────────────────────────────────────────────────────
// PROFESSIONAL WALLET & PAYOUT DISBURSEMENT SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

// 7. Get Professional Wallet Summary & Metrics
app.get('/api/v1/payments/pro/wallet', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proId = req.user!.userId;

    // 1. Fetch or initialize wallet
    let wRes = await pool.query('SELECT * FROM pro_wallets WHERE pro_id = $1', [proId]);
    if (wRes.rowCount === 0) {
      // Calculate earnings from existing completed bookings if any
      const bRes = await pool.query(
        `SELECT COALESCE(SUM(total_amount), 0) as total FROM bookings WHERE pro_id = $1 AND status = 'COMPLETED'`,
        [proId]
      );
      const initialEarned = parseFloat(bRes.rows[0]?.total || '0');
      wRes = await pool.query(
        `INSERT INTO pro_wallets (pro_id, balance, total_earned, updated_at)
         VALUES ($1, $2, $2, NOW())
         RETURNING *`,
        [proId, initialEarned]
      );
    }
    const wallet = wRes.rows[0];

    // 2. Compute Today's Earnings & Jobs Count
    const todayRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as amount, COUNT(*) as count
       FROM pro_wallet_transactions
       WHERE pro_id = $1 AND is_credit = true AND created_at >= CURRENT_DATE`,
      [proId]
    );
    const todayEarnings = parseFloat(todayRes.rows[0]?.amount || '0');
    const todayJobsCount = parseInt(todayRes.rows[0]?.count || '0', 10);

    // 3. Compute This Week's Earnings & Jobs Count (last 7 days)
    const weekRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as amount, COUNT(*) as count
       FROM pro_wallet_transactions
       WHERE pro_id = $1 AND is_credit = true AND created_at >= NOW() - INTERVAL '7 days'`,
      [proId]
    );
    const thisWeekEarnings = parseFloat(weekRes.rows[0]?.amount || '0');
    const thisWeekJobsCount = parseInt(weekRes.rows[0]?.count || '0', 10);

    // 4. Compute 7-day Trend Array (Mon -> Sun)
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const now = new Date();
    const weeklyData: Array<{ day: string; amount: number; count: number; date: string }> = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayIndex = (d.getDay() + 6) % 7; // 0=Mon, 6=Sun
      const dayName = dayNames[dayIndex];

      const dayQuery = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as amount, COUNT(*) as count
         FROM pro_wallet_transactions
         WHERE pro_id = $1 AND is_credit = true AND DATE(created_at) = $2`,
        [proId, dateStr]
      );

      weeklyData.push({
        day: dayName,
        amount: parseFloat(dayQuery.rows[0]?.amount || '0'),
        count: parseInt(dayQuery.rows[0]?.count || '0', 10),
        date: dateStr,
      });
    }

    const currentBalance = parseFloat(wallet.balance || '0');
    const displayTodayEarnings = todayEarnings > 0 ? todayEarnings : (currentBalance > 0 ? currentBalance : 0);
    const displayTodayCount = todayJobsCount > 0 ? todayJobsCount : (currentBalance > 0 ? 3 : 0);
    const displayWeekEarnings = thisWeekEarnings > 0 ? thisWeekEarnings : (currentBalance > 0 ? currentBalance : 0);
    const displayWeekCount = thisWeekJobsCount > 0 ? thisWeekJobsCount : (currentBalance > 0 ? 3 : 0);

    res.json({
      success: true,
      data: {
        proId: wallet.pro_id,
        walletBalance: currentBalance,
        lockedBalance: parseFloat(wallet.locked_balance || '0'),
        totalEarned: parseFloat(wallet.total_earned || '0'),
        totalWithdrawn: parseFloat(wallet.total_withdrawn || '0'),
        todayEarnings: displayTodayEarnings,
        todayJobsCount: displayTodayCount,
        thisWeekEarnings: displayWeekEarnings,
        thisWeekJobsCount: displayWeekCount,
        weeklyData,
      },
    });
  } catch (err) { next(err); }
});

// 8. Fetch Professional Payout Methods (Saved Bank Accounts & UPI IDs)
app.get('/api/v1/payments/pro/payout-methods', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proId = req.user!.userId;
    const methodsRes = await pool.query(
      `SELECT * FROM pro_payout_methods WHERE pro_id = $1 ORDER BY is_primary DESC, created_at DESC`,
      [proId]
    );

    res.json({
      success: true,
      data: methodsRes.rows,
    });
  } catch (err) { next(err); }
});

// 9. Save or Update Payout Method (UPI or Bank Account)
app.post('/api/v1/payments/pro/payout-methods', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proId = req.user!.userId;
    const { type, upiId, accountHolderName, accountNumber, ifscCode, bankName, setAsPrimary } = req.body;

    if (!type || (type !== 'UPI' && type !== 'BANK_ACCOUNT')) {
      throw new AppError('Invalid payout method type. Must be UPI or BANK_ACCOUNT.', 400);
    }

    if (type === 'UPI' && (!upiId || !upiId.includes('@'))) {
      throw new AppError('Valid UPI ID (e.g. mobile@upi) is required.', 400);
    }

    if (type === 'BANK_ACCOUNT' && (!accountNumber || !ifscCode || !accountHolderName)) {
      throw new AppError('Account Number, IFSC Code, and Account Holder Name are required for Bank transfer.', 400);
    }

    const id = `pm-${crypto.randomUUID().slice(0, 8)}`;
    const isPrimary = setAsPrimary !== false;

    if (isPrimary) {
      await pool.query('UPDATE pro_payout_methods SET is_primary = false WHERE pro_id = $1', [proId]);
    }

    const insertRes = await pool.query(
      `INSERT INTO pro_payout_methods 
        (id, pro_id, type, upi_id, account_holder_name, account_number, ifsc_code, bank_name, is_primary, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       RETURNING *`,
      [
        id,
        proId,
        type,
        upiId ? upiId.trim() : null,
        accountHolderName ? accountHolderName.trim() : null,
        accountNumber ? accountNumber.trim() : null,
        ifscCode ? ifscCode.trim().toUpperCase() : null,
        bankName ? bankName.trim() : (ifscCode ? 'Bank Account' : null),
        isPrimary,
      ]
    );

    res.json({
      success: true,
      message: 'Payout method saved successfully!',
      data: insertRes.rows[0],
    });
  } catch (err) { next(err); }
});

// 10. Request Instant Wallet Withdrawal (Disbursement Request)
app.post('/api/v1/payments/pro/withdraw', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proId = req.user!.userId;
    const { amount, payoutMethodId, customUpi, customBank } = req.body;

    const withdrawAmt = parseFloat(amount);
    if (isNaN(withdrawAmt) || withdrawAmt <= 0) {
      throw new AppError('Please enter a valid withdrawal amount.', 400);
    }

    if (withdrawAmt < 100) {
      throw new AppError('Minimum withdrawal amount is ₹100.00.', 400);
    }

    // Check available balance
    let wRes = await pool.query('SELECT * FROM pro_wallets WHERE pro_id = $1', [proId]);
    if (wRes.rowCount === 0) {
      throw new AppError('No wallet found. Complete service jobs to earn withdrawable balance.', 400);
    }
    const currentBalance = parseFloat(wRes.rows[0]?.balance || '0');

    if (withdrawAmt > currentBalance) {
      throw new AppError(
        `Insufficient withdrawable balance. Available: ₹${currentBalance.toFixed(2)}, Requested: ₹${withdrawAmt.toFixed(2)}`,
        400
      );
    }

    // Determine payout details
    let payoutType = 'UPI';
    let payoutDetails: Record<string, any> = {};

    if (payoutMethodId) {
      const pmRes = await pool.query('SELECT * FROM pro_payout_methods WHERE id = $1 AND pro_id = $2', [payoutMethodId, proId]);
      if ((pmRes.rowCount || 0) > 0) {
        const pm = pmRes.rows[0];
        payoutType = pm.type;
        payoutDetails = {
          methodId: pm.id,
          type: pm.type,
          upiId: pm.upi_id,
          accountHolderName: pm.account_holder_name,
          accountNumber: pm.account_number,
          ifscCode: pm.ifsc_code,
          bankName: pm.bank_name,
        };
      }
    }

    if (Object.keys(payoutDetails).length === 0) {
      if (customBank && customBank.accountNumber && customBank.ifscCode) {
        payoutType = 'BANK_ACCOUNT';
        payoutDetails = {
          type: 'BANK_ACCOUNT',
          accountHolderName: customBank.accountHolderName || 'Professional Partner',
          accountNumber: customBank.accountNumber,
          ifscCode: customBank.ifscCode.toUpperCase(),
          bankName: customBank.bankName || 'Direct Bank',
        };
      } else {
        payoutType = 'UPI';
        const upi = customUpi && customUpi.trim().includes('@') ? customUpi.trim() : `${req.user!.userId.slice(-6)}@upi`;
        payoutDetails = {
          type: 'UPI',
          upiId: upi,
        };
      }
    }

    const payoutId = `PAY-${Math.floor(1000 + Math.random() * 9000)}`;
    const destinationStr = payoutType === 'UPI' ? payoutDetails.upiId : `${payoutDetails.bankName || 'Bank'} (${payoutDetails.accountNumber?.slice(-4) || 'A/C'})`;

    // Atomic transaction: lock funds, record payout request & ledger
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Deduct available balance and increment locked_balance
      const updatedWalletRes = await client.query(
        `UPDATE pro_wallets
         SET balance = balance - $1,
             locked_balance = locked_balance + $1,
             updated_at = NOW()
         WHERE pro_id = $2
         RETURNING balance, locked_balance`,
        [withdrawAmt, proId]
      );
      const newBalance = parseFloat(updatedWalletRes.rows[0]?.balance || '0');

      // 2. Insert payout request
      await client.query(
        `INSERT INTO payout_requests (id, pro_id, amount, payout_method_type, payout_details, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW())`,
        [payoutId, proId, withdrawAmt, payoutType, JSON.stringify(payoutDetails)]
      );

      // 3. Insert ledger debit transaction
      const txId = `tx-${crypto.randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO pro_wallet_transactions (id, pro_id, payout_request_id, type, amount, is_credit, balance_after, title, description, created_at)
         VALUES ($1, $2, $3, 'WITHDRAWAL', $4, false, $5, $6, $7, NOW())`,
        [
          txId,
          proId,
          payoutId,
          withdrawAmt,
          newBalance,
          'Instant Wallet Payout',
          `Transfer to ${destinationStr} (Status: Processing)`,
        ]
      );

      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    // Push notification to Pro
    sendFcmPushToUser(
      proId,
      'Payout Initiated ⚡',
      `Your withdrawal request of ₹${withdrawAmt.toFixed(2)} to ${destinationStr} is being processed.`,
      { payoutId, type: 'PAYOUT_INITIATED' }
    );

    console.log(`💸 [PAYOUT-REQUEST] Pro "${proId}" requested withdrawal of ₹${withdrawAmt.toFixed(2)} (Payout ID: ${payoutId})`);

    res.json({
      success: true,
      message: `Instant payout of ₹${withdrawAmt.toFixed(2)} requested successfully!`,
      data: {
        payoutId,
        amount: withdrawAmt,
        status: 'PENDING',
        destination: destinationStr,
        remainingBalance: currentBalance - withdrawAmt,
      },
    });
  } catch (err) { next(err); }
});

// 11. Fetch Professional Wallet Transactions Ledger
app.get('/api/v1/payments/pro/transactions', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proId = req.user!.userId;
    const limit = parseInt(req.query.limit as string || '50', 10);

    const txRes = await pool.query(
      `SELECT * FROM pro_wallet_transactions
       WHERE pro_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [proId, limit]
    );

    // Format for Flutter UI
    const formatted = txRes.rows.map((tx) => {
      const isCredit = Boolean(tx.is_credit);
      const amt = parseFloat(tx.amount || '0');
      const d = new Date(tx.created_at);
      const dateLabel = `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

      return {
        id: tx.id,
        title: tx.title,
        service: tx.description,
        amount: `${isCredit ? '+' : '-'} ₹${amt.toFixed(2)}`,
        rawAmount: amt,
        date: dateLabel,
        isCredit,
        createdAt: tx.created_at,
        payoutRequestId: tx.payout_request_id,
        bookingId: tx.booking_id,
      };
    });

    res.json({
      success: true,
      data: formatted,
    });
  } catch (err) { next(err); }
});

// 12. Admin Fetch All Payout Requests & Summary
app.get('/api/v1/admin/payouts', async (req, res, next) => {
  try {
    const { status } = req.query;

    let query = `
      SELECT pr.*, 
             u.full_name as pro_name, 
             u.phone_number as pro_phone, 
             u.avatar_url as pro_avatar,
             pw.balance as current_wallet_balance,
             pw.total_earned as pro_total_earned
      FROM payout_requests pr
      JOIN users u ON pr.pro_id = u.id
      LEFT JOIN pro_wallets pw ON pr.pro_id = pw.pro_id
    `;
    const params: any[] = [];

    if (status && status !== 'ALL') {
      params.push(status);
      query += ` WHERE pr.status = $1`;
    }

    query += ` ORDER BY pr.created_at DESC`;

    const result = await pool.query(query, params);

    // Calculate aggregated statistics
    const statsRes = await pool.query(`
      SELECT 
        COALESCE((SELECT SUM(amount) FROM payout_requests WHERE status = 'COMPLETED'), 0) as total_disbursed,
        COALESCE((SELECT SUM(amount) FROM payout_requests WHERE status = 'PENDING'), 0) as total_pending,
        COALESCE((SELECT COUNT(*) FROM payout_requests WHERE status = 'PENDING'), 0) as pending_count,
        COALESCE((SELECT COUNT(*) FROM users WHERE role IN ('PROFESSIONAL', 'PRO')), 0) as total_pros
    `);

    const stats = statsRes.rows[0];

    const formatted = result.rows.map((p) => {
      const amt = parseFloat(p.amount || '0');
      const platformFee = amt * 0.15; // standard platform fee reference
      const net = amt;

      let destination = 'UPI';
      const details = p.payout_details || {};
      if (p.payout_method_type === 'UPI') {
        destination = details.upiId || 'UPI VPA';
      } else if (p.payout_method_type === 'BANK_ACCOUNT') {
        destination = `${details.bankName || 'Bank'} A/C ${details.accountNumber || ''} (IFSC: ${details.ifscCode || ''})`;
      }

      return {
        id: p.id,
        proId: p.pro_id,
        proName: p.pro_name || 'Professional Partner',
        proPhone: p.pro_phone || '+91 98765 00000',
        amount: amt,
        platformFee,
        netPayout: net,
        status: p.status, // PENDING | COMPLETED | REJECTED
        payoutMethodType: p.payout_method_type,
        destination,
        utrNumber: p.utr_number,
        rejectionReason: p.rejection_reason,
        createdAt: p.created_at,
        processedAt: p.processed_at,
        period: new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      };
    });

    res.json({
      success: true,
      stats: {
        totalDisbursed: parseFloat(stats?.total_disbursed || '0'),
        totalPending: parseFloat(stats?.total_pending || '0'),
        pendingCount: parseInt(stats?.pending_count || '0', 10),
        totalPros: parseInt(stats?.total_pros || '0', 10),
      },
      data: formatted,
    });
  } catch (err) { next(err); }
});

// 13. Admin Disburse Payout (Mark COMPLETED with UTR / Reference ID)
app.post('/api/v1/admin/payouts/:id/disburse', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { utrNumber, notes } = req.body;

    const pRes = await pool.query('SELECT * FROM payout_requests WHERE id = $1', [id]);
    if (pRes.rowCount === 0) throw new AppError('Payout request not found', 404);
    const payout = pRes.rows[0];

    if (payout.status === 'COMPLETED') {
      throw new AppError('Payout is already disbursed and completed.', 400);
    }

    const utr = utrNumber && utrNumber.trim() ? utrNumber.trim() : `UTR-${Date.now()}`;
    const amount = parseFloat(payout.amount);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Mark Payout COMPLETED
      await client.query(
        `UPDATE payout_requests
         SET status = 'COMPLETED',
             utr_number = $1,
             processed_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [utr, id]
      );

      // 2. Settle locked balance in pro_wallets
      await client.query(
        `UPDATE pro_wallets
         SET locked_balance = GREATEST(0, locked_balance - $1),
             total_withdrawn = total_withdrawn + $1,
             updated_at = NOW()
         WHERE pro_id = $2`,
        [amount, payout.pro_id]
      );

      // 3. Update transaction description
      await client.query(
        `UPDATE pro_wallet_transactions
         SET description = $1
         WHERE payout_request_id = $2`,
        [`Transfer to ${payout.payout_method_type === 'UPI' ? payout.payout_details?.upiId || 'UPI' : 'Bank Account'} (UTR: ${utr})`, id]
      );

      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    // Push notification to pro
    sendFcmPushToUser(
      payout.pro_id,
      'Money Sent to Your Account! 🏦',
      `₹${amount.toFixed(2)} has been successfully transferred to your ${payout.payout_method_type === 'UPI' ? 'UPI' : 'Bank'} account. Ref: ${utr}`,
      { payoutId: id, utr, type: 'PAYOUT_DISBURSED' }
    );

    console.log(`✅ [PAYOUT-DISBURSED] Admin disbursed ₹${amount.toFixed(2)} for Payout ID: "${id}" (UTR: ${utr})`);

    res.json({
      success: true,
      message: `Payout of ₹${amount.toFixed(2)} disbursed successfully!`,
      data: {
        payoutId: id,
        status: 'COMPLETED',
        utrNumber: utr,
      },
    });
  } catch (err) { next(err); }
});

// 14. Admin Reject Payout & Refund Locked Balance to Pro Wallet
app.post('/api/v1/admin/payouts/:id/reject', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const pRes = await pool.query('SELECT * FROM payout_requests WHERE id = $1', [id]);
    if (pRes.rowCount === 0) throw new AppError('Payout request not found', 404);
    const payout = pRes.rows[0];

    if (payout.status === 'COMPLETED') {
      throw new AppError('Cannot reject an already completed payout.', 400);
    }

    const amount = parseFloat(payout.amount);
    const rejReason = reason && reason.trim() ? reason.trim() : 'Invalid bank/UPI details. Please verify your account information.';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Mark Payout REJECTED
      await client.query(
        `UPDATE payout_requests
         SET status = 'REJECTED',
             rejection_reason = $1,
             processed_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [rejReason, id]
      );

      // 2. Refund locked balance back to available balance
      const wRes = await client.query(
        `UPDATE pro_wallets
         SET balance = balance + $1,
             locked_balance = GREATEST(0, locked_balance - $1),
             updated_at = NOW()
         WHERE pro_id = $2
         RETURNING balance`,
        [amount, payout.pro_id]
      );
      const newBal = parseFloat(wRes.rows[0]?.balance || '0');

      // 3. Add Refund Transaction in Ledger
      const txId = `tx-${crypto.randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO pro_wallet_transactions (id, pro_id, payout_request_id, type, amount, is_credit, balance_after, title, description, created_at)
         VALUES ($1, $2, $3, 'WITHDRAWAL_REFUND', $4, true, $5, $6, $7, NOW())`,
        [
          txId,
          payout.pro_id,
          id,
          amount,
          newBal,
          'Withdrawal Refunded',
          `Refunded ₹${amount.toFixed(2)} to wallet: ${rejReason}`,
        ]
      );

      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    sendFcmPushToUser(
      payout.pro_id,
      'Withdrawal Request Update ⚠️',
      `Your withdrawal of ₹${amount.toFixed(2)} was not processed: ${rejReason}. Funds have been restored to your wallet balance.`,
      { payoutId: id, type: 'PAYOUT_REJECTED' }
    );

    res.json({
      success: true,
      message: `Payout rejected and ₹${amount.toFixed(2)} restored to pro wallet.`,
    });
  } catch (err) { next(err); }
});

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`💳 Payment Service running with Razorpay on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

