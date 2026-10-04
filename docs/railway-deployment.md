# Railway + SQLite 배포

현재 Node.js 서버를 서비스 하나로 실행하고, 예약 DB는 `/data`에 연결한 영구 볼륨에 보관한다. 별도 PostgreSQL·Redis·Vercel 서비스는 생성하지 않는다. Dockerfile은 Node.js 22와 운영 기본값을 지정하며, 비밀 정보와 로컬 예약 데이터는 이미지에 포함하지 않는다.

## 비용 기준

2026-10-04 공식 요금 기준, USD이며 세금·SMS·도메인·추가 사용료는 별도다.

| 구성 | 월 기본 비용 |
|---|---:|
| Railway Hobby + SQLite | 최소 $5, 리소스 사용량 $5 포함 |
| Vercel Pro + Supabase Free | 최소 $20, Supabase 무료 한도와 중지 정책 적용 |
| Vercel Pro + Supabase Pro | 최소 $45, Vercel 배포 사용자 1명·Supabase Micro 프로젝트 1개 기준 |

Railway Hobby는 월 사용량이 $3이면 $5, $7이면 $7을 청구한다. 서버 RAM·CPU·전송량·볼륨 등에 따라 총액이 달라진다. 첫 달 서버 예산은 **$10~15를 계획값**으로 잡고 Usage의 예상 청구액으로 조정한다. 이 범위는 측정 결과나 요금 보장이 아니다.

- [Railway 요금](https://docs.railway.com/pricing/plans)
- [Vercel Pro 요금](https://vercel.com/docs/plans/pro-plan)
- [Supabase 요금](https://supabase.com/pricing)
- [Supabase 무료 프로젝트 중지](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Railway 비용 제어](https://docs.railway.com/pricing/cost-control)

문자 비용은 `발송 건수 × 업체의 메시지 유형별 단가`로 별도 계산한다. 현재 확정 안내는 긴 메시지이므로 실제 업체에서 SMS/LMS 분류를 확인한다. 재발송과 업체가 청구하는 실패 건도 예산에 반영한다. 기본 Railway 도메인으로 시작하면 별도 도메인을 구매할 필요가 없다.

## 서비스 생성

1. Railway에 로그인하고 사용할 요금제와 결제 조건을 확인한다.
2. GitHub 저장소 `Superkid0714/2026-banhxeo-reservation`의 `main`을 연결한다. 아래 파일들이 GitHub에 반영된 뒤 배포한다.
3. 루트 `Dockerfile`을 사용한다. 별도 Build Command와 Start Command를 입력하지 않는다. Dockerfile의 `CMD`가 서버를 실행한다.
4. 서비스에 영구 볼륨을 추가하고 Mount Path를 **`/data`**로 지정한다. 이 볼륨 없이는 운영 예약을 받지 않는다.
5. 복제본은 **1개**, Serverless/App Sleeping은 **비활성화**한다. 문자 발송·만료 처리가 서버 내 타이머에서 실행되므로 서버를 계속 실행해야 한다.
6. Healthcheck Path는 **`/api/v1/config`**로 지정한다. 기존 API를 사용해 서버와 DB 접근을 함께 확인한다.
7. 아래 운영 변수를 설정한 뒤 배포한다. `PORT`는 Railway가 제공하는 값을 사용한다.
8. Networking에서 Railway 도메인을 생성하고 HTTPS 주소의 `/reserve` 및 `/admin/login`을 확인한다.

영구 볼륨을 사용하는 서비스는 재배포 시 짧은 중단이 발생할 수 있다. 예약 접수가 몰리는 시간에는 재배포를 피한다. [볼륨 제약](https://docs.railway.com/volumes/reference)

## 운영 변수

실제 값은 Railway Variables에만 입력하고 저장소나 채팅에 비밀키를 기록하지 않는다.

| 변수 | 값 또는 의미 |
|---|---|
| `NODE_ENV` | `production` (Docker 기본값) |
| `HOST` | `0.0.0.0` (Docker 기본값) |
| `DATA_DIR` | `/data` (Docker 기본값, 볼륨 경로와 일치해야 함) |
| `ADMIN_USERNAME` | 운영 관리자 ID |
| `ADMIN_PASSWORD` | 충분히 긴 임의 비밀번호, 최소 16자; 예시 비밀번호 사용 불가 |
| `BANK_NAME` | 실제 은행 |
| `BANK_ACCOUNT` | 실제 입금 계좌 |
| `BANK_ACCOUNT_HOLDER` | 실제 예금주 |
| `RESERVATION_UNIT_PRICE` | 상품 가격, 현재 예시 `5500` |
| `RESERVATION_LIMIT` | 날짜별 수량 한도, 현재 예시 `100` |
| `MAX_ORDER_QUANTITY` | 주문당 최대 수량, 현재 예시 `5` |
| `PAYMENT_TIMEOUT_MINUTES` | 입금 대기 만료 시간, 현재 예시 `60` |
| `SMS_MODE` | `aligo` |
| `ALIGO_USER_ID` | 알리고 로그인 ID |
| `ALIGO_API_KEY` | 알리고 문자 API 키 |
| `ALIGO_SENDER` | 알리고에서 등록·승인받은 발신번호, 숫자만 입력 |

현재 앱은 운영 환경에서 모의 SMS, 알리고 테스트 모드와 기본 비밀번호를 거부한다. 알리고에 가입해 문자 API 신청, 발신번호 등록·승인, 발송 잔액 준비를 마쳐야 서버가 실제 문자를 접수할 수 있다. 별도 문자 어댑터 서비스는 필요 없다. 기존 로컬 개발은 `.env.example`의 `SMS_MODE=mock`으로 계속 사용할 수 있다.

알리고 API는 문자 요청을 접수하면 메시지 ID를 반환한다. 앱의 `SENT` 상태는 **업체 접수**를 뜻하며 단말 수신을 뜻하지 않는다. 네트워크 오류나 서버 재시작으로 접수 여부가 불분명하면 자동 재발송하지 않는다. 관리자 화면에서 알리고 발송 내역과 수신 번호를 확인한 후 재발송한다. 알리고 API에는 이 앱의 작업 ID를 이용한 중복 방지 계약이 문서화돼 있지 않다. [알리고 문자 API](https://smartsms.aligo.in/admin/api/spec.html)

행사 날짜와 시간대는 `server.mjs`에 고정돼 있다. 현재 날짜는 2026-10-06 및 2026-10-07이므로 실제 행사 일정과 대조한다.

## 운영 확인과 비용 관리

- 비공개 시험 예약으로 생성 → 관리자 입금 확인 → 실제 문자 → 고객 확정 화면을 확인한다. 알리고 발송 결과와 실제 단말 수신을 확인한다. 실제 입금 내역과 예약 금액을 대조한다.
- 서버 재시작 후 시험 예약이 유지되는지 확인한다. 로컬의 기존 예약 DB는 자동 이전되지 않는다.
- 영구 볼륨의 일일 백업을 설정하고 복구 절차를 확인한다. SQLite WAL 모드이므로 실행 중 `reservations.sqlite` 파일만 복사해 백업하지 않는다. DB 일관성을 보장하는 방식으로 백업하고 복구본을 검증한다.
- Usage에서 첫날과 일주일 뒤 예상 청구액을 확인한다. 비용 알림을 설정하되, 지출 상한 도달 시 서비스 중단이 발생할 수 있으므로 예약 운영 기간에는 중단 기준을 확인한다.
- 행사 종료 후 환불·문자·조회 업무와 개인정보 보관 기간을 마무리한 다음, 필요한 데이터를 내보내고 서비스를 종료한다. 서비스를 중지해도 남은 볼륨이나 다른 리소스는 비용이 발생할 수 있다.

## 로컬 검증

```powershell
npm run check
npm test
```

Docker가 실행 중인 환경에서는 `docker build -t banhxeo-reservation .`로 이미지를 검증한다. 실제 배포 후에는 HTTPS, 관리자 로그인, 문자 수신, 볼륨 유지 검증이 추가로 필요하다.
