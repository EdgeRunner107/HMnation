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
    // 해당 유저의 executed=false 데이터 중
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





app.post('/accountgetter/:login_id', async (req, res) => {

  const { login_id } = req.params;

  const {
    donor_name,
    amount,
    text
  } = req.body;


  // ======================================================
  // 1. 들어온 원본 데이터 로그
  // ======================================================

  console.log('\n========================================');
  console.log('[ACCOUNTGETTER] 요청 수신');
  console.log('시간:', new Date().toISOString());
  console.log('login_id:', login_id);
  console.log('body 원본:', req.body);
  console.log('donor_name:', donor_name);
  console.log('amount:', amount);
  console.log('text:', text);
  console.log('========================================\n');


  // ======================================================
  // 2. 기본 검증
  // ======================================================

  if (!login_id) {
    console.log('[ACCOUNTGETTER] ❌ login_id 없음');

    return res.status(400).json({
      ok: false,
      error: 'login_id is required'
    });
  }


  if (!donor_name || typeof donor_name !== 'string') {
    console.log('[ACCOUNTGETTER] ❌ donor_name 오류:', donor_name);

    return res.status(400).json({
      ok: false,
      error: 'donor_name is required'
    });
  }


  // ======================================================
  // 3. 금액 정리
  //
  // 예:
  // "20,000원"
  // "20,000"
  // 20000
  //
  // -> 20000
  // ======================================================

  const parsedAmount =
    Number(
      String(amount ?? '')
        .replace(/[^\d]/g, '')
    );


  console.log(
    '[ACCOUNTGETTER] 금액 변환:',
    amount,
    '→',
    parsedAmount
  );


  if (
    !Number.isFinite(parsedAmount) ||
    parsedAmount <= 0
  ) {

    console.log(
      '[ACCOUNTGETTER] ❌ 잘못된 금액:',
      amount
    );

    return res.status(400).json({
      ok: false,
      error: 'Invalid amount'
    });
  }


  try {

    // ======================================================
    // 4. 유저 조회
    // ======================================================

    console.log(
      `[ACCOUNTGETTER] 유저 조회: ${login_id}`
    );


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
        '[ACCOUNTGETTER] ❌ 유저 조회 오류:',
        userError
      );

      return res.status(500).json({
        ok: false,
        error: 'User lookup failed'
      });
    }


    if (!user) {

      console.log(
        `[ACCOUNTGETTER] ❌ 존재하지 않는 유저: ${login_id}`
      );

      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });
    }


    console.log(
      '[ACCOUNTGETTER] ✅ 유저 확인:',
      user
    );


    if (user.is_active === false) {

      console.log(
        `[ACCOUNTGETTER] ❌ 비활성 유저: ${login_id}`
      );

      return res.status(403).json({
        ok: false,
        error: 'User is inactive'
      });
    }


    // ======================================================
    // 5. DB에 넣을 최종 데이터
    // ======================================================

    const insertData = {

      user_id:
        user.id,

      donor_name:
        donor_name.trim(),

      amount:
        parsedAmount,

      text:
        typeof text === 'string'
          ? text.trim()
          : '',

      executed:
        false
    };


    console.log(
      '[ACCOUNTGETTER] DB 저장 예정 데이터:'
    );

    console.log(
      insertData
    );


    // ======================================================
    // 6. bank_donations INSERT
    // ======================================================

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
        '[ACCOUNTGETTER] ❌ DB 저장 실패:',
        insertError
      );

      return res.status(500).json({
        ok: false,
        error: 'Donation insert failed'
      });
    }


    // ======================================================
    // 7. 최종 저장 결과 로그
    // ======================================================

    console.log('\n----------------------------------------');
    console.log('[ACCOUNTGETTER] ✅ 계좌후원 저장 완료');
    console.log('DB ID:', donation.id);
    console.log('user_id:', donation.user_id);
    console.log('후원자:', donation.donor_name);
    console.log('금액:', donation.amount);
    console.log('텍스트:', donation.text);
    console.log('executed:', donation.executed);
    console.log('created_at:', donation.created_at);
    console.log('----------------------------------------\n');


    return res.status(201).json({

      ok: true,

      donation

    });


  } catch (error) {

    console.error(
      '[ACCOUNTGETTER] ❌ 예상하지 못한 오류:',
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