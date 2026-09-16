import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const app = express();

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
  );
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },

    realtime: {
      transport: ws
    }
  }
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/plain' }));


// ======================================================
// 서버 상태 확인
// ======================================================

app.get('/', (req, res) => {

  res.json({
    ok: true,
    message: 'Bank Donation API running'
  });

});


// ======================================================
// 미실행 후원 1건 조회
//
// GET /api/donations/next?login_id=testuser
// ======================================================

// ======================================================
// Login
//
// POST /api/login
// ======================================================

app.post('/api/login', async (req, res) => {

  const {
    login_id,
    password
  } = req.body || {};


  if (
    !login_id ||
    !password ||
    typeof login_id !== 'string' ||
    typeof password !== 'string'
  ) {

    return res.status(400).json({
      ok: false,
      error: 'login_id and password are required'
    });

  }


  try {

    const {
      data: user,
      error: userError
    } = await supabase
      .from('users')
      .select(`
        id,
        login_id,
        password,
        payment_date,
        is_active
      `)
      .eq('login_id', login_id)
      .maybeSingle();


    if (userError) {

      console.error(
        'Login user lookup failed:',
        userError
      );

      return res.status(500).json({
        ok: false,
        error: 'Login failed'
      });

    }


    if (!user || user.password !== password) {

      return res.status(401).json({
        ok: false,
        error: 'Invalid login credentials'
      });

    }


    if (user.is_active === false) {

      return res.status(403).json({
        ok: false,
        error: 'User is inactive'
      });

    }


    return res.json({

      ok: true,

      user: {
        id:
          user.id,

        login_id:
          user.login_id,

        payment_date:
          user.payment_date,

        is_active:
          user.is_active
      }

    });


  } catch (error) {

    console.error(
      'Unexpected error in POST /api/login:',
      error
    );


    return res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });

  }

});


// ======================================================
// User donations by login_id in the URL
// ======================================================

app.get(['/api/u', '/api/u/:login_id'], async (req, res) => {
  try {
    const { login_id } = req.params;
    console.log(`[USER DONATIONS] request login_id=${login_id || ''}`);

    if (!login_id || !login_id.trim()) {
      return res.status(400).json({ ok: false, error: 'login_id is required' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, login_id, is_active')
      .eq('login_id', login_id)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ ok: false, error: 'User is inactive' });
    }

    console.log(`[USER DONATIONS] user_id=${user.id}`);

    const { data: donations, error: donationsError } = await supabase
      .from('bank_donations')
      .select('id, user_id, donor_name, amount, text, executed, canceled, created_at, executed_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (donationsError) throw donationsError;

    console.log(`[USER DONATIONS] rows=${(donations || []).length}`);
    return res.json({
      ok: true,
      login_id: user.login_id,
      user_id: user.id,
      donations: donations || []
    });
  } catch (error) {
    console.error('[USER DONATIONS] lookup failed:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

app.get('/api/u/:login_id/next', async (req, res) => {
  try {
    const { login_id } = req.params;
    console.log(`[USER DONATIONS NEXT] request login_id=${login_id || ''}`);

    if (!login_id || !login_id.trim()) {
      return res.status(400).json({ ok: false, error: 'login_id is required' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, login_id, is_active')
      .eq('login_id', login_id)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ ok: false, error: 'User is inactive' });
    }

    console.log(`[USER DONATIONS NEXT] user_id=${user.id}`);

    const { data: donation, error: donationError } = await supabase
      .from('bank_donations')
      .select('id, donor_name, amount, text, created_at')
      .eq('user_id', user.id)
      .eq('executed', false)
      .eq('canceled', false)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (donationError) throw donationError;

    console.log(donation
      ? `[USER DONATIONS NEXT] donation_id=${donation.id}`
      : '[USER DONATIONS NEXT] no pending donation');
    return res.json({
      ok: true,
      login_id: user.login_id,
      donation: donation || null
    });
  } catch (error) {
    console.error('[USER DONATIONS NEXT] lookup failed:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});


// ======================================================
// Retry / cancel only donations owned by the URL user
// ======================================================

async function updateUserDonation(req, res, values) {
  const { login_id, id } = req.params;
  const donationId = Number(id);

  if (!login_id || !login_id.trim()) {
    return res.status(400).json({ ok: false, error: 'login_id is required' });
  }
  if (!Number.isSafeInteger(donationId) || donationId <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid donation id' });
  }

  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, login_id, is_active')
      .eq('login_id', login_id)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ ok: false, error: 'User is inactive' });
    }

    const { data: donation, error: lookupError } = await supabase
      .from('bank_donations')
      .select('id')
      .eq('id', donationId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!donation) {
      return res.status(404).json({ ok: false, error: 'Donation not found' });
    }

    // Keep the ownership condition on the write as well as the lookup.
    const { data: updatedDonation, error: updateError } = await supabase
      .from('bank_donations')
      .update(values)
      .eq('id', donationId)
      .eq('user_id', user.id)
      .select('id, user_id, donor_name, amount, text, executed, canceled, created_at, executed_at')
      .maybeSingle();

    if (updateError) throw updateError;
    if (!updatedDonation) {
      return res.status(404).json({ ok: false, error: 'Donation not found' });
    }

    return res.json({ ok: true, donation: updatedDonation });
  } catch (error) {
    console.error('[USER DONATION UPDATE] failed:', error);
    return res.status(500).json({ ok: false, error: 'Donation update failed' });
  }
}

app.post('/api/u/:login_id/donations/:id/retry', (req, res) => {
  return updateUserDonation(req, res, {
    executed: false,
    executed_at: null,
    canceled: false
  });
});

app.post('/api/u/:login_id/donations/:id/cancel', (req, res) => {
  return updateUserDonation(req, res, { canceled: true });
});


// ======================================================
// Current donation ranking and reset for a user
// ======================================================

app.get('/api/u/:login_id/ranking', async (req, res) => {
  try {
    const { login_id } = req.params;
    console.log(`[USER RANKING] request login_id=${login_id || ''}`);

    if (!login_id || !login_id.trim()) {
      return res.status(400).json({ ok: false, error: 'login_id is required' });
    }

    const requestedLimit = typeof req.query.limit === 'string'
      ? Number(req.query.limit)
      : NaN;
    const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 100
      ? requestedLimit
      : 6;

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, login_id, is_active, ranking_reset_at')
      .eq('login_id', login_id)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ ok: false, error: 'User is inactive' });
    }

    console.log(`[USER RANKING] user_id=${user.id}`);
    console.log(`[USER RANKING] limit=${limit}`);

    const { data: ranking, error: rankingError } = await supabase.rpc(
      'get_current_donation_ranking',
      { p_user_id: user.id, p_limit: limit }
    );

    if (rankingError) throw rankingError;

    console.log(`[USER RANKING] rows=${(ranking || []).length}`);
    return res.json({
      ok: true,
      login_id: user.login_id,
      ranking_reset_at: user.ranking_reset_at,
      ranking: ranking || []
    });
  } catch (error) {
    console.error('[USER RANKING] lookup failed:', error);
    return res.status(500).json({ ok: false, error: 'Ranking lookup failed' });
  }
});

app.post('/api/u/:login_id/ranking/reset', async (req, res) => {
  try {
    const { login_id } = req.params;
    console.log(`[RANKING RESET] request login_id=${login_id || ''}`);

    if (!login_id || !login_id.trim()) {
      return res.status(400).json({ ok: false, error: 'login_id is required' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, login_id, is_active')
      .eq('login_id', login_id)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ ok: false, error: 'User is inactive' });
    }

    console.log(`[RANKING RESET] user_id=${user.id}`);
    const resetAt = new Date().toISOString();

    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({ ranking_reset_at: resetAt })
      .eq('id', user.id)
      .select('id, login_id, ranking_reset_at')
      .single();

    if (updateError) throw updateError;

    console.log(`[RANKING RESET] ranking_reset_at=${updatedUser.ranking_reset_at}`);
    return res.json({
      ok: true,
      login_id: updatedUser.login_id,
      ranking_reset_at: updatedUser.ranking_reset_at
    });
  } catch (error) {
    console.error('[RANKING RESET] update failed:', error);
    return res.status(500).json({ ok: false, error: 'Ranking reset failed' });
  }
});


// ======================================================
// All donations for a user
//
// GET /api/donations?login_id=testuser
// ======================================================

app.get('/api/donations', async (req, res) => {

  const { login_id } = req.query;


  if (!login_id || typeof login_id !== 'string') {

    return res.status(400).json({
      ok: false,
      error: 'login_id query parameter is required'
    });

  }


  try {

    const {
      data: user,
      error: userError
    } = await supabase
      .from('users')
      .select('id, login_id, is_active')
      .eq('login_id', login_id)
      .maybeSingle();


    if (userError) {

      console.error(
        'User lookup failed:',
        userError
      );

      return res.status(500).json({
        ok: false,
        error: 'User lookup failed'
      });

    }


    if (!user) {

      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });

    }


    if (user.is_active === false) {

      return res.status(403).json({
        ok: false,
        error: 'User is inactive'
      });

    }


    const {
      data: donations,
      error: donationsError
    } = await supabase
      .from('bank_donations')
      .select(`
        id,
        user_id,
        donor_name,
        amount,
        text,
        executed,
        canceled,
        created_at,
        executed_at
      `)
      .eq('user_id', user.id)
      .order(
        'created_at',
        {
          ascending: false
        }
      );


    if (donationsError) {

      console.error(
        'Donations lookup failed:',
        donationsError
      );

      return res.status(500).json({
        ok: false,
        error: 'Donations lookup failed'
      });

    }


    return res.json({

      ok: true,

      donations:
        donations || []

    });


  } catch (error) {

    console.error(
      'Unexpected error in GET /api/donations:',
      error
    );


    return res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });

  }

});


// ======================================================
// Next pending donation for a user
//
// GET /api/donations/next?login_id=testuser
// ======================================================

app.get('/api/donations/next', async (req, res) => {

  const { login_id } = req.query;


  if (!login_id || typeof login_id !== 'string') {

    return res.status(400).json({
      ok: false,
      error: 'login_id query parameter is required'
    });

  }


  try {

    // --------------------------------------------------
    // 유저 조회
    // --------------------------------------------------

    const {
      data: user,
      error: userError
    } = await supabase
      .from('users')
      .select('id, login_id, is_active')
      .eq('login_id', login_id)
      .maybeSingle();


    if (userError) {

      console.error(
        'User lookup failed:',
        userError
      );

      return res.status(500).json({
        ok: false,
        error: 'User lookup failed'
      });

    }


    if (!user) {

      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });

    }


    if (user.is_active === false) {

      return res.status(403).json({
        ok: false,
        error: 'User is inactive'
      });

    }


    // --------------------------------------------------
    // 해당 유저의 executed=false AND canceled=false 데이터 중
    // 가장 오래된 1건 조회
    // --------------------------------------------------

    const {
      data: donation,
      error: donationError
    } = await supabase
      .from('bank_donations')
      .select(`
        id,
        donor_name,
        amount,
        text,
        created_at
      `)
      .eq('user_id', user.id)
      .eq('executed', false)
      .eq('canceled', false)
      .order(
        'created_at',
        {
          ascending: true
        }
      )
      .limit(1)
      .maybeSingle();


    if (donationError) {

      console.error(
        'Donation lookup failed:',
        donationError
      );

      return res.status(500).json({
        ok: false,
        error: 'Donation lookup failed'
      });

    }


    return res.json({

      ok: true,

      donation:
        donation || null

    });


  } catch (error) {

    console.error(
      'Unexpected error in GET /api/donations/next:',
      error
    );


    return res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });

  }

});


// ======================================================
// 후원 실행 완료
//
// POST /api/donations/:id/complete
// ======================================================

app.post('/api/donations/:id/complete', async (req, res) => {

  const { id } = req.params;


  // --------------------------------------------------
  // ID 검증
  // --------------------------------------------------

  const donationId =
    Number(id);


  if (
    !Number.isInteger(donationId) ||
    donationId <= 0
  ) {

    return res.status(400).json({
      ok: false,
      error: 'Invalid donation id'
    });

  }


  try {

    // --------------------------------------------------
    // 먼저 해당 후원 존재 여부 확인
    // --------------------------------------------------

    const {
      data: donation,
      error: lookupError
    } = await supabase
      .from('bank_donations')
      .select(`
        id,
        user_id,
        donor_name,
        amount,
        text,
        executed,
        canceled,
        executed_at
      `)
      .eq('id', donationId)
      .maybeSingle();


    if (lookupError) {

      console.error(
        'Donation lookup failed:',
        lookupError
      );

      return res.status(500).json({
        ok: false,
        error: 'Donation lookup failed'
      });

    }


    // --------------------------------------------------
    // 데이터가 없는 경우
    // --------------------------------------------------

    if (!donation) {

      return res.status(404).json({
        ok: false,
        error: 'Donation not found'
      });

    }


    // --------------------------------------------------
    // 취소된 후원은 완료 처리하지 않음
    // --------------------------------------------------

    if (donation.canceled === true) {
      return res.status(409).json({
        ok: false,
        error: 'Canceled donation cannot be completed'
      });
    }


    // --------------------------------------------------
    // 이미 완료된 데이터
    //
    // 중복 요청이 와도 에러로 만들지 않고
    // 성공으로 반환
    // --------------------------------------------------

    if (donation.executed === true) {

      return res.json({

        ok: true,

        already_completed: true,

        donation: {
          id: donation.id,
          executed: true,
          executed_at:
            donation.executed_at
        }

      });

    }


    // --------------------------------------------------
    // executed = true
    // executed_at = 현재시간
    // --------------------------------------------------

    const now =
      new Date().toISOString();


    const {
      data: updatedDonation,
      error: updateError
    } = await supabase
      .from('bank_donations')
      .update({

        executed: true,

        executed_at: now

      })
      .eq('id', donationId)
      .eq('executed', false)
      .eq('canceled', false)
      .select(`
        id,
        donor_name,
        amount,
        text,
        executed,
        executed_at
      `)
      .maybeSingle();


    if (updateError) {

      console.error(
        'Donation complete update failed:',
        updateError
      );

      return res.status(500).json({
        ok: false,
        error: 'Donation update failed'
      });

    }


    if (!updatedDonation) {

      return res.status(409).json({
        ok: false,
        error: 'Donation was already processed'
      });

    }


    // --------------------------------------------------
    // 완료
    // --------------------------------------------------

    console.log(
      `[COMPLETE] donation id=${donationId}`,
      {
        donor_name:
          updatedDonation.donor_name,

        amount:
          updatedDonation.amount
      }
    );


    return res.json({

      ok: true,

      donation:
        updatedDonation

    });


  } catch (error) {

    console.error(
      `Unexpected error in POST /api/donations/${id}/complete:`,
      error
    );


    return res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });

  }

});


// ======================================================
// 계좌 입금 문자 수신 API
//
// POST /accountgetter/:login_id
//
// 지원 형식
//
// 1. text/plain
// 문자 원문 그대로 전송
//
// 2. application/json
// {
//   "text": "문자 원문"
// }
//
// 또는
//
// {
//   "message": "문자 원문"
// }
//
// ======================================================
app.post('/accountgetter/:login_id', async (req, res) => {

  const { login_id } = req.params;

  try {

    // ==================================================
    // 1. 휴대폰에서 들어온 원본 문자 추출
    // ==================================================

    let rawText = '';

    // text/plain으로 들어온 경우
    if (typeof req.body === 'string') {

      rawText = req.body;

    }

    // JSON으로 들어온 경우
    else if (req.body && typeof req.body === 'object') {

      rawText =
        req.body.text ||
        req.body.message ||
        req.body.sms ||
        req.body.body ||
        '';

    }


    console.log('\n========================================');
    console.log('[ACCOUNTGETTER] 📱 문자 수신');
    console.log('login_id:', login_id);
    console.log('Content-Type:', req.headers['content-type']);
    console.log('원본 body:', req.body);
    console.log('원본 문자:\n' + rawText);
    console.log('========================================\n');


    // ==================================================
    // 2. 문자 존재 여부
    // ==================================================

    if (!rawText || typeof rawText !== 'string') {

      return res.status(400).json({
        ok: false,
        error: 'SMS text is required'
      });

    }


    // ==================================================
    // 3. 줄 단위 정리
    // ==================================================

    const lines = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);


    console.log(
      '[ACCOUNTGETTER] 문자 줄:',
      lines
    );


    // ==================================================
    // 4. 입금 금액 파싱
    //
    // 지원 형식 1
    // 입금 10,000원
    //
    // 지원 형식 2
    // 5,000원 입금 되었어요.
    // ==================================================

    let amount = null;
    let depositIndex = -1;
    let kakaoPaySecurities = false;


    // --------------------------------------------------
    // 기존 은행 문자 형식
    //
    // 입금 10,000원
    // --------------------------------------------------

    depositIndex = lines.findIndex((line) =>
      /^입금\s*/.test(line)
    );


    if (depositIndex !== -1) {

      const depositLine =
        lines[depositIndex];


      const amountMatch =
        depositLine.match(
          /입금\s*([\d,]+)\s*원?/
        );


      if (amountMatch) {

        amount =
          Number(
            amountMatch[1]
              .replace(/,/g, '')
          );

      }

    }


    // --------------------------------------------------
    // 카카오페이증권 형식
    //
    // 5,000원 입금 되었어요.
    // --------------------------------------------------

    if (!amount) {

      const kakaoIndex =
        lines.findIndex((line) =>
          /^\s*[\d,]+\s*원\s*입금/.test(line)
        );


      if (kakaoIndex !== -1) {

        const kakaoLine =
          lines[kakaoIndex];


        const kakaoAmountMatch =
          kakaoLine.match(
            /([\d,]+)\s*원\s*입금/
          );


        if (kakaoAmountMatch) {

          amount =
            Number(
              kakaoAmountMatch[1]
                .replace(/,/g, '')
            );


          depositIndex =
            kakaoIndex;


          kakaoPaySecurities =
            true;

        }

      }

    }


    // --------------------------------------------------
    // 금액을 찾지 못한 경우
    // --------------------------------------------------

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      console.log(
        '[ACCOUNTGETTER] ❌ 입금 금액을 찾지 못함'
      );


      return res.status(400).json({
        ok: false,
        error: 'Deposit amount not found'
      });

    }


    // ==================================================
    // 5. 입금자 정보 찾기
    // ==================================================

    let rawDonorText = '';


    // --------------------------------------------------
    // 카카오페이증권
    //
    // 문자에 입금자명이 없으므로 익명 처리
    // --------------------------------------------------

    if (kakaoPaySecurities) {

      rawDonorText =
        '익명';


      console.log(
        '[ACCOUNTGETTER] 카카오페이증권 알림 감지'
      );


      console.log(
        '[ACCOUNTGETTER] 입금자명이 없어 익명 처리'
      );

    }


    // --------------------------------------------------
    // 기존 은행 문자
    //
    // 입금 1,000원
    // 잔액 4,607원
    // 경석/되냐
    // 666***58901011
    // 기업
    // --------------------------------------------------

    else {

      const balanceIndex =
        lines.findIndex(
          (line, index) =>
            index > depositIndex &&
            /^잔액\s*/.test(line)
        );


      if (
        balanceIndex !== -1 &&
        lines[balanceIndex + 1]
      ) {

        rawDonorText =
          lines[balanceIndex + 1];

      }


      // 기존 fallback 유지
      if (!rawDonorText) {

        rawDonorText =
          lines[depositIndex + 2] || '';

      }

    }


    if (!rawDonorText) {

      return res.status(400).json({
        ok: false,
        error: 'Donor name not found'
      });

    }


    // ==================================================
    // 6. 닉네임 / 텍스트 분리
    //
    // "경석/되냐"
    // donor_name = "경석"
    // text       = "되냐"
    //
    // "경석느금"
    // donor_name = "경석느금"
    // text       = "경석느금"
    //
    // "경석/오늘/방송/화이팅"
    // donor_name = "경석"
    // text       = "오늘/방송/화이팅"
    //
    // 카카오페이증권
    // donor_name = "익명"
    // text       = "익명"
    // ==================================================

    let donorName =
      rawDonorText.trim();

    let donationText =
      rawDonorText.trim();


    if (rawDonorText.includes('/')) {

      const slashIndex =
        rawDonorText.indexOf('/');


      const nicknamePart =
        rawDonorText
          .slice(0, slashIndex)
          .trim();


      const textPart =
        rawDonorText
          .slice(slashIndex + 1)
          .trim();


      if (nicknamePart) {

        donorName =
          nicknamePart;

      }


      if (textPart) {

        donationText =
          textPart;

      } else {

        donationText =
          donorName;

      }

    }


    // ==================================================
    // 7. 최종 파싱 로그
    // ==================================================

    console.log(
      '[ACCOUNTGETTER] ✅ 문자 파싱 완료'
    );


    console.log(
      '원본 입금자 문자열:',
      rawDonorText
    );


    console.log(
      '후원자명:',
      donorName
    );


    console.log(
      '텍스트:',
      donationText
    );


    console.log(
      '금액:',
      amount
    );


    console.log(
      '형식:',
      kakaoPaySecurities
        ? '카카오페이증권'
        : '기존 은행문자'
    );


    // ==================================================
    // 8. 유저 확인
    // ==================================================

    const {
      data: user,
      error: userError
    } = await supabase
      .from('users')
      .select(
        'id, login_id, is_active'
      )
      .eq(
        'login_id',
        login_id
      )
      .maybeSingle();


    if (userError) {

      console.error(
        '[ACCOUNTGETTER] 유저 조회 오류:',
        userError
      );


      return res.status(500).json({
        ok: false,
        error: 'User lookup failed'
      });

    }


    if (!user) {

      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });

    }


    if (user.is_active === false) {

      return res.status(403).json({
        ok: false,
        error: 'User is inactive'
      });

    }


    // ==================================================
    // 9. bank_donations 저장
    // ==================================================

    const insertData = {

      user_id:
        user.id,

      donor_name:
        donorName,

      amount:
        amount,

      text:
        donationText,

      executed:
        false

    };


    console.log(
      '[ACCOUNTGETTER] DB 저장 예정:',
      insertData
    );


    const {
      data: donation,
      error: insertError
    } = await supabase
      .from('bank_donations')
      .insert(
        insertData
      )
      .select(`
        id,
        user_id,
        donor_name,
        amount,
        text,
        executed,
        created_at
      `)
      .single();


    if (insertError) {

      console.error(
        '[ACCOUNTGETTER] DB 저장 실패:',
        insertError
      );


      return res.status(500).json({
        ok: false,
        error: 'Donation insert failed'
      });

    }


    // ==================================================
    // 10. 성공
    // ==================================================

    console.log('\n----------------------------------------');
    console.log('[ACCOUNTGETTER] ✅ 계좌후원 저장 완료');
    console.log('ID:', donation.id);
    console.log('후원자:', donation.donor_name);
    console.log('금액:', donation.amount);
    console.log('텍스트:', donation.text);
    console.log('executed:', donation.executed);
    console.log('----------------------------------------\n');


    return res.status(201).json({

      ok: true,

      source:
        kakaoPaySecurities
          ? 'kakaopay_securities'
          : 'bank',

      parsed: {

        donor_name:
          donorName,

        amount:
          amount,

        text:
          donationText

      },

      donation

    });


  } catch (error) {

    console.error(
      '[ACCOUNTGETTER] 예상하지 못한 오류:',
      error
    );


    return res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });

  }

});



// ======================================================
// 서버 실행
// ======================================================

app.listen(
  PORT,
  () => {

    console.log(
      `Bank Donation API running on port ${PORT}`
    );

  }
);
