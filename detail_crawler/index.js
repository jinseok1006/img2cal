// processPostLambda.js
const {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const { SQSClient } = require("@aws-sdk/client-sqs");
const cheerio = require("cheerio");
const axios = require("axios");
require("dotenv").config();

// AWS 클라이언트 설정
const dynamoDb = new DynamoDBClient({ region: "ap-northeast-2" });
const sqs = new SQSClient({ region: "ap-northeast-2" });

const TABLE_NAME = process.env.TABLE_NAME;

exports.handler = async (event) => {
  // Step Functions에서 단일 게시물 데이터가 전달됨
  const post = event.post;

  console.log(`post: ${JSON.stringify(post)}`);

  try {
    // DynamoDB에서 postId 조회
    const exists = await checkPostExists(post.postId);
    if (exists) {
      console.log(`Post ${post.postId} already exists. Skipping.`);
      return { postId: post.postId, skipped: true, scucess: true };
    }

    // 크롤링 및 데이터 처리
    const details = await extractPostDetails(post.url);

    // DynamoDB에 데이터 저장
    await savePostToDynamoDB({
      ...post,
      ...details,
    });
    console.log(`Post ${post.postId} success!`);
    return { postId: post.postId, success: true, skipped: false };
  } catch (error) {
    console.error(`Error processing post ${post.postId}:`, error);
    return { postId: post.postId, error: error.message, success: false };
  }
};

// 상세 게시글 데이터 추출 함수
async function extractPostDetails(postUrl) {
  try {
    const response = await axios.get(postUrl);
    const html = response.data;
    const $ = cheerio.load(html);

    const title = $(".com-post-hd-01 .title").text().trim();
    const date = $(".com-post-hd-01 .etc-list li").eq(1).text().trim();
    const content = $(".com-post-content-01").text().trim();

    const images = [];
    $(".com-post-content-01 img").each((_, element) => {
      const imgSrc = $(element).attr("src");
      if (!imgSrc) {
        return;
      }
      
      if (
        imgSrc.startsWith("/common/file.do") ||
        imgSrc.startsWith("https://www.jbnu.ac.kr/common/file.do")
      ) {
        images.push(
          imgSrc.startsWith("/common/file.do")
            ? `https://www.jbnu.ac.kr${imgSrc}`
            : imgSrc
        );
      }
    });


    return { date, content, images };
  } catch (error) {
    console.error("Error extracting post details:", error);
    throw new Error("Failed to extract post details");
  }
}

// DynamoDB에서 postId 존재 여부 확인 함수
async function checkPostExists(postId) {
  const params = {
    TableName: TABLE_NAME,
    Key: marshall({ postId }),
  };

  try {
    const result = await dynamoDb.send(new GetItemCommand(params));
    return !!result.Item;
  } catch (error) {
    console.error(`Failed to check existence of post ${postId}:`, error);
    throw new Error("Failed to check post existence in DynamoDB");
  }
}

// DynamoDB에 데이터 저장 함수
async function savePostToDynamoDB(post) {
  const params = {
    TableName: TABLE_NAME,
    Item: marshall({
      postId: post.postId,
      title: post.title,
      url: post.url,
      date: post.date,
      content: post.content,
      images: post.images.map((img) => ({
        imageUrl: img,
        ocrText: "",
      })),
    }),
  };

  try {
    await dynamoDb.send(new PutItemCommand(params));
    console.log(`Post ${post.postId} saved to DynamoDB with empty OCR fields`);
  } catch (error) {
    console.error(`Failed to save post ${post.postId} to DynamoDB:`, error);
    throw new Error("Failed to save post to DynamoDB");
  }
}
