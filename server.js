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
      .map(line => line.trim())
      .filter(Boolean);


    console.log(
      '[ACCOUNTGETTER] 문자 줄:',
      lines
    );


    // ==================================================
    // 4. "입금 10,000원" 찾기
    // ==================================================

    const depositIndex =
      lines.findIndex(line =>
        /^입금\s*/.test(line)
      );


    if (depositIndex === -1) {

      console.log(
        '[ACCOUNTGETTER] ❌ 입금 문구 없음'
      );

      return res.status(400).json({
        ok: false,
        error: 'Deposit amount not found'
      });

    }


    const depositLine =
      lines[depositIndex];


    // 입금 10,000원
    // 입금 10000원
    // 둘 다 대응

    const amountMatch =
      depositLine.match(
        /입금\s*([\d,]+)\s*원?/
      );


    if (!amountMatch) {

      return res.status(400).json({
        ok: false,
        error: 'Invalid deposit amount'
      });

    }


    const amount =
      Number(
        amountMatch[1]
          .replace(/,/g, '')
      );


    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      return res.status(400).json({
        ok: false,
        error: 'Invalid amount'
      });

    }


    // ==================================================
    // 5. 입금자명 찾기
    //
    // 현재 기업은행 문자 구조:
    //
    // 입금 10,000원
    // 잔액 13,607원
    // 경석느금
    // 666***58901011
    // 기업
    //
    // 따라서 "잔액" 다음 줄을 입금자명으로 사용
    // ==================================================

    const balanceIndex =
      lines.findIndex(
        (line, index) =>
          index > depositIndex &&
          /^잔액\s*/.test(line)
      );


    let donorName = '';


    if (
      balanceIndex !== -1 &&
      lines[balanceIndex + 1]
    ) {

      donorName =
        lines[balanceIndex + 1];

    }


    // 혹시 잔액 줄을 못 찾으면
    // 입금 줄 + 2번째 줄을 fallback으로 사용

    if (!donorName) {

      donorName =
        lines[depositIndex + 2] || '';

    }


    if (!donorName) {

      return res.status(400).json({
        ok: false,
        error: 'Donor name not found'
      });

    }


    // ==================================================
    // 6. 파싱 결과
    // ==================================================

    console.log(
      '[ACCOUNTGETTER] ✅ 문자 파싱 완료'
    );

    console.log(
      '후원자명:',
      donorName
    );

    console.log(
      '금액:',
      amount
    );


    // ==================================================
    // 7. 유저 확인
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
    // 8. bank_donations 저장
    // ==================================================

    const insertData = {

      user_id:
        user.id,

      donor_name:
        donorName,

      amount:
        amount,

      // 계좌후원에는 별도 메시지가 없으므로 비움
      text:
        '',

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
    // 9. 성공
    // ==================================================

    console.log('\n----------------------------------------');
    console.log('[ACCOUNTGETTER] ✅ 계좌후원 저장 완료');
    console.log('ID:', donation.id);
    console.log('후원자:', donation.donor_name);
    console.log('금액:', donation.amount);
    console.log('executed:', donation.executed);
    console.log('----------------------------------------\n');


    return res.status(201).json({

      ok: true,

      parsed: {
        donor_name:
          donorName,

        amount:
          amount
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
