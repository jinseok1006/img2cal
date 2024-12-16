// fetchPostsLambda.js
const cheerio = require("cheerio");
const axios = require("axios");

const MAX_PAGES = 5;

exports.handler = async (event) => {
  const maxPages=MAX_PAGES;
  try {
    const posts = await fetchLatestPosts(maxPages);
    return {
      statusCode: 200,
      posts, // Step Functions으로 반환
    };
  } catch (error) {
    console.error("Error fetching posts:", error);
    throw new Error("Failed to fetch posts");
  }
};

// 게시물 목록 fetch 및 추출 함수
async function fetchLatestPosts(maxPages) {
  const baseUrl = "https://www.jbnu.ac.kr/web/news/notice/sub01.do";
  let pageIndex = 1;
  const allPosts = [];

  while (pageIndex <= maxPages) {
    const url = pageIndex === 1 ? baseUrl : `${baseUrl}?pageIndex=${pageIndex}`;
    console.log(`Fetching posts from ${url}`);

    try {
      const response = await axios.get(url);
      const html = response.data;
      const $ = cheerio.load(html);

      $("tr.tr-normal").each((_, element) => {
        const onclickValue = $(element).find(".td-title > a").attr("onclick");
        if (!onclickValue) return;

        const postId = parseInt(
          onclickValue.match(/pf_DetailMove\('([0-9]+)'\)/)[1],
          10
        );
        const postTitle = $(element).find(".td-title > a").text().trim();

        allPosts.push({
          postId,
          title: postTitle,
          url: `https://www.jbnu.ac.kr/web/Board/${postId}/detailView.do`,
        });
      });

      pageIndex++;
    } catch (error) {
      console.error(`Error fetching posts from page ${pageIndex}:`, error);
      break;
    }
  }

  return allPosts;
}
