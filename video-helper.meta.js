// ==UserScript==
// @name         学习通视频助手：弹题逐项重试
// @namespace    local.chaoxing.video-helper
// @version      3.2.4
// @description  修复任务已完成但视频仍在播放时的切节：先暂停、选择下一视频，确认目录与播放器更新后继续；保留目录估算与累计统计。
// @match        https://*.chaoxing.com/mycourse/studentstudy*
// @match        https://*.chaoxing.com/mooc-ans/mycourse/studentstudy*
// @match        https://*.chaoxing.com/ananas/modules/video/index*
// @match        https://hike.zhihuishu.com/aidedteaching/sourceLearning/sourceLearning*
// @match        https://studyvideoh5.zhihuishu.com/stuStudy*
// @match        https://stuonline.zhihuishu.com/stuonline/stuLearnReportNew/index*
// @grant        GM_listValues
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/kylezheng320-sudo/course-video-helper/main/video-helper.meta.js
// @downloadURL  https://raw.githubusercontent.com/kylezheng320-sudo/course-video-helper/main/video-helper.user.js
// ==/UserScript==
