// img2cal_step_classifier.js
const {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const OpenAI = require("openai/index.js");
const { sys_prompt } = require("./sys_prompt");
const vision = require("@google-cloud/vision"); // Vision API 클라이언트 가져오기
const axios = require("axios");
require("dotenv").config();

// 환경 변수 및 설정
const DYNAMODB_TABLE_NAME = "img2cal_step_final";

// AWS 클라이언트 설정
const dynamoDb = new DynamoDBClient({ region: "ap-northeast-2" });

// OpenAI 클라이언트 설정
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // OpenAI API 키 설정
});

// Vision API 클라이언트 설정
const client = new vision.ImageAnnotatorClient({
  keyFilename: process.env.VISION_API_KEY, // 서비스 계정 키 파일 경로
});

// ================================
// VISION API 관련 함수
// ================================

/**
 * 이미지 URL을 다운로드하고 Vision API로 바이너리 데이터를 전송
 */
async function analyzeImageWithVision(imagePath) {
  try {
    // 이미지 다운로드
    const response = await axios.get(imagePath, {
      responseType: "arraybuffer",
    });

    // Vision API에 바이너리 데이터 전달
    const [result] = await client.textDetection({
      image: { content: Buffer.from(response.data) },
    });

    const extractedText =
      result.textAnnotations[0]?.description || "No text found";

    return extractedText.trim();
  } catch (error) {
    console.error("Error during Vision API call:", error.message);
    throw error;
  }
}

// ================================
// chatgpt 분류함수
// ================================

// 시스템 메시지와 사용자 메시지를 포함한 프롬프트 생성
function createMessages(
  title,
  content,
  ocrExtractedText,
  currentImageCount,
  totalImages
) {
  const systemMessage = {
    role: "system",
    content: sys_prompt,
  };

  const userMessage = {
    role: "user",
    content: `Announcement:
    {
      "title": "${title}",
      "content": "${content}",
      "ocrExtracted": "${ocrExtractedText || "No OCR data available"}",
      "currentImageCount": ${currentImageCount},
      "totalImages": ${totalImages}
    }`,
  };

  return [systemMessage, userMessage];
}

// OpenAI API 호출로 분류 수행
async function classifyPostWithLLM(
  title,
  content,
  ocrExtractedText,
  currentImageCount,
  totalImages
) {
  const messages = createMessages(
    title,
    content,
    ocrExtractedText,
    currentImageCount,
    totalImages
  );

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: messages,
    max_tokens: 500, // 필요에 따라 조정
    temperature: 0.2,
    top_p: 0.9,
  });

  let generatedText = response.choices[0]?.message?.content?.trim();

  // Markdown 블록 제거
  if (generatedText.startsWith("```")) {
    generatedText = generatedText
      .replace(/^```(?:json)?\n/, "")
      .replace(/\n```$/, "")
      .trim();
  }

  try {
    // JSON 파싱 시도
    const result = JSON.parse(generatedText);

    // 시스템 프롬프트에 정의된 응답 형태 확인
    if (!result.status) {
      throw new Error("응답에 'status' 필드가 없습니다.");
    }

    // 상태별 처리
    if (result.status === "approved") {
      if (!result.calendar) {
        throw new Error("승인된 이벤트에 'calendar' 데이터가 없습니다.");
      }

      return {
        status: "approved",
        reason: result.reason || "No reason provided",
        calendar: result.calendar,
      };
    } else if (result.status === "needs_more_images") {
      // Check if maximum images have been processed
      if (currentImageCount >= totalImages) {
        // Override to rejected since no more images are available
        return {
          status: "rejected",
          reason: "Maximum image count reached; cannot process further images.",
        };
      }
      return {
        status: "needs_more_images",
        reason: result.reason || "Needs more images for verification.",
      };
    } else if (result.status === "rejected") {
      return {
        status: "rejected",
        reason: result.reason || "No reason provided",
      };
    } else {
      throw new Error(`알 수 없는 상태: ${result.status}`);
    }
  } catch (error) {
    console.error("JSON 파싱 실패 또는 예상치 못한 응답:", generatedText);
    throw new Error("응답이 JSON 형식이 아니거나 예상된 구조가 아닙니다.");
  }
}

// ================================
// DynamoDB 관련 함수
// ================================

// DynamoDB에서 postId 기반으로 게시물 조회
async function getPostFromDynamoDB(postId) {
  const params = {
    TableName: DYNAMODB_TABLE_NAME,
    Key: marshall({ postId }),
  };
  const result = await dynamoDb.send(new GetItemCommand(params));
  if (!result.Item) return null;
  return unmarshall(result.Item);
}

/**
 * DynamoDB에서 특정 게시물(postId)의 이미지 OCR 결과를 업데이트합니다.
 * @param {number} postId - 게시물 ID
 * @param {number} index - 업데이트할 이미지의 인덱스
 * @param {string} ocrText - OCR로 추출된 텍스트
 */
async function updateOcrTextInDynamoDB(postId, index, ocrText) {
  if (!ocrText || typeof ocrText !== "string") {
    console.error(`유효하지 않은 OCR 텍스트: ${ocrText}`);
    throw new Error("유효하지 않은 OCR 텍스트입니다.");
  }

  const params = {
    TableName: DYNAMODB_TABLE_NAME,
    Key: marshall({ postId }),
    UpdateExpression: `SET #images[${index}].ocrText = :ocrText`,
    ExpressionAttributeNames: {
      "#images": "images",
    },
    ExpressionAttributeValues: marshall({
      ":ocrText": ocrText,
    }),
  };

  try {
    await dynamoDb.send(new UpdateItemCommand(params));
    console.log(
      `게시물 ${postId}의 이미지 ${index} OCR 텍스트가 업데이트되었습니다.`
    );
  } catch (error) {
    console.error(
      `DynamoDB 업데이트 실패: 게시물 ID ${postId}, 이미지 인덱스 ${index}`
    );
    console.error(`오류 세부사항: ${error.message}`);
    console.error(`DynamoDB 요청 데이터: ${JSON.stringify(params, null, 2)}`);
    throw new Error("DynamoDB에 OCR 텍스트를 업데이트하는 데 실패했습니다.");
  }
}

async function updatePostVerificationStatus(
  postId,
  isApproved,
  calendarData = null,
  reason = "",
  revalidationRequested // 재요청 필드 옵션으로 변경
) {
  // 기본 업데이트 객체 구성
  const updateObject = {
    ":approved": isApproved,
    ":calendarData": calendarData || {},
    ":reason": reason,
  };

  // revalidationRequested가 true인 경우 객체에 추가
  if (revalidationRequested === true) {
    console.log('업데이트하고싶당');
    updateObject[":revalidationRequested"] = true;
  }

  // 모든 값을 한 번에 marshall
  const expressionAttributeValues = marshall(updateObject);

  // 업데이트 표현식 구성
  let updateExpression = "SET #approved = :approved, #calendarData = :calendarData, #reason = :reason";
  const expressionAttributeNames = {
    "#approved": "approved",
    "#calendarData": "calendarData",
    "#reason": "reason",
  };

  if (revalidationRequested === true) {
    updateExpression += ", #revalidationRequested = :revalidationRequested";
    expressionAttributeNames["#revalidationRequested"] = "revalidationRequested";
  }

  const params = {
    TableName: DYNAMODB_TABLE_NAME,
    Key: marshall({ postId }),
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
  };

  try {
    await dynamoDb.send(new UpdateItemCommand(params));
    console.log(`Updated verification status for postId: ${postId}`);
  } catch (error) {
    console.error(
      `Failed to update verification status for postId: ${postId}:`,
      error
    );
    throw new Error("Failed to update verification status in DynamoDB");
  }
}

// ================================
// chatgpt 분류 및 OCR 통합 Lambda
// ================================

exports.handler = async (event) => {
  // console.log("Received event:", JSON.stringify(event, null, 2)); // 디버깅용 로그

  const post = event; // Step Functions에서 직접 전달된 post 객체

  console.log(post);

  if (!post || !post.postId) {
    throw new Error("Invalid input: 'postId' is missing.");
  }

  const postId = post.postId;


  console.log(`Processing postId: ${postId}`);
  console.log(`Using table: ${DYNAMODB_TABLE_NAME}`);

  try {
    // DynamoDB에서 게시물 조회
    const existingPost = await getPostFromDynamoDB(postId);
    if (!existingPost) {
      console.log(`No post found for postId: ${postId}`);
      throw new Error("Post not found in DynamoDB.");
    }
    const title = existingPost.title;
    const content = existingPost.content;
    const images = existingPost.images;
    const totalImages = existingPost.images.length;

    // 요청된 이미지 개수 (예: 처음에는 1개, 추가 요청 시 2개씩 증가)
    let currentImageCount = post.nextImageCount || 1;

    if (currentImageCount <= 0) {
      console.log(`잘못된 이미지 개수: ${currentImageCount}. 기본값 1로 설정.`);
      currentImageCount = 1;
    }

    // 요청한 이미지 개수가 총 이미지 개수를 초과하면 최대값으로 제한
    if (currentImageCount > totalImages) {
      console.log(`요청 이미지 개수(${currentImageCount})가 총 이미지 개수(${totalImages})를 초과하여 총 이미지 갯수로 제한됩니다.`);
      currentImageCount = totalImages;
    }

    // 요청한 이미지 개수만큼 OCR 처리
    let ocrExtractedText = "";
    for (let i = 0; i < currentImageCount; i++) {
      const { imageUrl, ocrText } = images[i];

      if (ocrText) {
        ocrExtractedText += ocrText + "\n";
      } else {
        try {
          const extractedText = await analyzeImageWithVision(imageUrl);
          await updateOcrTextInDynamoDB(postId, i, extractedText);
          ocrExtractedText += extractedText + "\n";
        } catch (ocrError) {
          console.error(`OCR 실패: 게시물 ID ${postId}, 이미지 인덱스 ${i}. 오류: ${ocrError.message}`);
          continue; // 다음 이미지로 이동
        }
      }
    }

    // OpenAI API로 검증 요청 (currentImageCount와 totalImages 추가)
    const verification = await classifyPostWithLLM(
      title,
      content,
      ocrExtractedText,
      currentImageCount,
      totalImages
    );

    // 검증 결과 처리
    if (verification.status === "approved") {
      await updatePostVerificationStatus(
        postId,
        true,
        verification.calendar,
        verification.reason
        // revalidationRequested는 업데이트하지 않음
      );
    } else if (verification.status === "needs_more_images") {
      // 추가 이미지 검증 요청: revalidationRequested true로 설정
      if (currentImageCount >= totalImages) {
        console.log(`추가 검증 요청 중단: 게시물 ID ${postId} (이미 모든 이미지를 사용했습니다).`);
        await updatePostVerificationStatus(postId, false, null, verification.reason);
      } else {
        const nextImageCount = Math.min(currentImageCount + 2, totalImages);
        await updatePostVerificationStatus(postId, false, null, verification.reason, true);
        // Step Functions로 재검증 요청을 위한 출력을 구성
        return {
          postId,
          status: verification.status,
          reason: verification.reason,
          nextImageCount,
        };
      }
    } else if (verification.status === "rejected") {
      await updatePostVerificationStatus(postId, false, null, verification.reason);
    } else {
      console.error(`OpenAI 응답에서 알 수 없는 상태: ${verification.status}`);
      await updatePostVerificationStatus(postId, false, null, verification.reason);
    }

    return {
      postId,
      status: verification.status,
      success: true,
    };
  } catch (error) {
    console.error(`Error processing postId: ${postId}, Error: ${error.message}`);
    throw error; // Step Functions에서 Catch를 통해 오류 처리
  }
};
