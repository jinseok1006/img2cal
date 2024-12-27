const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const ical = require("ical-generator").default;
const { DateTime } = require("luxon");

// 환경 변수 설정
const TABLE_NAME = "img2cal_step_final";
const S3_BUCKET_NAME =  "img2cal-ical";

// 이벤트 타입 정의
const EVENT_TYPES = [
  "SeminarLecture",
  "CompetitionContest",
  "RecruitmentCareer",
  "CulturalEvent",
  "VolunteerActivity",
  "WorkshopPractice",
  "Others",
];
const EVENT_TYPES_KOR = {
  SeminarLecture: "세미나/강의",
  CompetitionContest: "대회/공모전",
  RecruitmentCareer: "채용/커리어",
  CulturalEvent: "문화 행사",
  VolunteerActivity: "봉사 활동",
  WorkshopPractice: "워크샵/실습",
  Others: "기타",
};

// AWS 클라이언트 초기화
const ddbClient = new DynamoDBClient({ region: "ap-northeast-2" });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: "ap-northeast-2" });

// Helper 함수: 값이 "undefined" 문자열이거나 빈 문자열인 경우 null로 반환
const sanitize = (value) => {
  if(value===null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "undefined") {
    return null;
  }
  return trimmed;
};

// Helper 함수: 값을 파싱하고 유효성을 검증
const parseDateTime = (value) => {
  if (!value) return null;

  // ISO 형식으로 시도
  let dt = DateTime.fromISO(value);
  if (dt.isValid) return dt;

  // 다른 형식 시도
  const formats = [
    "yyyy-MM-dd HH:mm:ss",
    "yyyy/MM/dd HH:mm",
    "yyyy-MM-dd",
    "yyyy/MM/dd",
    // 필요한 다른 형식 추가
  ];

  for (const format of formats) {
    dt = DateTime.fromFormat(value, format);
    if (dt.isValid) return dt;
  }

  return null;
};

// Helper 함수: 이벤트 시간 결정 로직
const determineEventTime = (calendarData, postId) => {
  const applicationPeriod = calendarData.applicationPeriod || {};
  const activityPeriod = calendarData.activityPeriod || {};

  // Sanitize and parse all relevant dates
  const appStartDt = parseDateTime(sanitize(applicationPeriod.startTime));
  let appEndDt = parseDateTime(sanitize(applicationPeriod.endTime));
  const actStartDt = parseDateTime(sanitize(activityPeriod.startTime));
  const actEndDt = parseDateTime(sanitize(activityPeriod.endTime));

  let startDt = null;
  let endDt = null;


  // 1. 접수일정(applicationPeriod)이 존재할 경우
  if (appEndDt) {
    // 종료시각이 0시0분인경우 18시로 전환
    if (appEndDt.hour === 0 && appEndDt.minute === 0) {
      appEndDt = appEndDt.set({ hour: 18, minute: 0 });
    }

    if (appStartDt) {
      if (appStartDt.toISODate() === appEndDt.toISODate()) {
        // 시작일과 종료일이 같은 경우
        startDt = appStartDt;
        endDt = appEndDt;
      } else {
        if (appEndDt.hour <= 9) {
          startDt = appEndDt.set({ hour: 0, minute: 1 });
        } else {
          startDt = appEndDt.set({ hour: 9, minute: 0 });
        }
        endDt = appEndDt;
      }
    } else {
      if (appEndDt.hour <= 9) {
        startDt = appEndDt.set({ hour: 0, minute: 1 });
      } else {
        startDt = appEndDt.set({ hour: 9, minute: 0 });
      }
      endDt = appEndDt;
    }

    console.log(`${postId}: ${appStartDt}, ${appEndDt} -> ${startDt}, ${endDt}`);
  }
  // 2. 접수일정이 없고 활동일정(activityPeriod)이 존재할 경우
  else if (actStartDt) {
    if (actStartDt.hour === 0 && actStartDt.minute === 0) {
      actStartDt = actStartDt.set({ hour: 9, minute: 0 });
    }
    
    startDt = actStartDt;
    if (actEndDt) {

      if (actStartDt.toISODate() === actEndDt.toISODate()) {
        // 시작일과 종료일이 같은 경우
        endDt = actEndDt;
      } else {
        // 시작일과 종료일이 다른 경우
        if (actStartDt.hour >= 18) {
          endDt = actStartDt.set({ hour: 23, minute: 59 });
        } else {
          endDt = actStartDt.set({ hour: 18, minute: 0 });
        }
      }
    } else {
      // 종료일이 없는 경우
      if (actStartDt.hour >= 18) {
        endDt = actStartDt.set({ hour: 23, minute: 59 });
      } else {
        endDt = actStartDt.set({ hour: 18, minute: 0 });
      }
    }
    console.log(`${postId}: ${actStartDt}, ${actEndDt} -> ${startDt}, ${endDt}`);

  }
  // 3. 유효한 기간 정보가 없는 경우
  else {
    console.error(`No valid period information for postId ${postId}`);
    return null;
  }

  // 추가적인 유효성 검사 (예: startDt < endDt)
  if (startDt > endDt) {
    console.error(`Start time is after end time for postId ${postId}. startDt: ${startDt}, endDt: ${endDt}`);
    return null;
  }



  return { startDt, endDt };
};

exports.handler = async (event) => {
  try {
    // 1. DynamoDB에서 전체 스캔 (데이터가 많을 경우 페이징 처리 필요)
    let items = [];
    let lastEvaluatedKey = undefined;
    do {
      const response = await docClient.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );
      if (response.Items) {
        items = items.concat(response.Items);
      }
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // 2. approved == true && eventType in EVENT_TYPES 필터
    const filtered = items.filter((item) => {
      const approved = item.approved === true;
      const calendarData = item.calendarData;
      const eventType = calendarData && calendarData.eventType;
      return approved && EVENT_TYPES.includes(eventType);
    });

    // 3. eventType별 그룹핑
    const eventsByType = {};
    for (const et of EVENT_TYPES) {
      eventsByType[et] = [];
    }

    filtered.forEach((item) => {
      const et = item.calendarData.eventType || "Others";
      if (EVENT_TYPES.includes(et)) {
        eventsByType[et].push(item);
      } else {
        eventsByType["Others"].push(item);
      }
    });

    // 4. eventType별 iCal 파일 생성 및 S3 업로드
    for (const etype of EVENT_TYPES) {
      const eventList = eventsByType[etype];
      if (!eventList || eventList.length === 0) continue;

      const cal = ical({
        prodId: {
          company: "jinseok1006",
          product: "JBNU_Img2Cal",
          language: "ko",
        },
        name: `JBNU_${EVENT_TYPES_KOR[etype]}`,
        timezone: "Asia/Seoul", // KST 기준
      });

      for (const it of eventList) {
        const calData = it.calendarData;
        const times = determineEventTime(calData, it.postId);

        if (!times) {
          // 유효한 시간이 설정되지 않은 경우 이벤트 생성을 건너뜀
          continue;
        }

        const { startDt, endDt } = times;

        let description = calData.description || "";

        const location = calData.location || "";
        const summary = it.title || "No Title";
        const url = it.url || "";

        // UID 생성
        const uid = it.postId
          ? `${it.postId}@jinseok1006.jbnu.ac.kr`
          : `${Date.now()}@jinseok1006.jbnu.ac.kr`;

        // iCal 이벤트 생성
        cal.createEvent({
          start: startDt.toJSDate(),
          end: endDt.toJSDate(),
          summary: summary,
          description: description,
          location: location,
          uid: uid,
          url: url,
        });
      }

      const icsContent = cal.toString();
      const icsFilename = `${etype}.ics`;

      // S3 업로드
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET_NAME,
          Key: icsFilename,
          Body: icsContent,
          ContentType: "text/calendar; charset=utf-8",
        })
      );
      console.log(`Uploaded ${icsFilename} to S3 bucket ${S3_BUCKET_NAME}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "iCal files generated and uploaded successfully",
      }),
    };
  } catch (error) {
    console.error("Error in handler:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal Server Error",
        error: error.message,
      }),
    };
  }
};
