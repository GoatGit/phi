/**
 * 插件中心与插件页共用的版心。
 *
 * 宽度按内容决定，不按「习惯」：卡片与列表要铺开，表单与长文本要收窄。
 * 同一页里切页签时，版心随当前页的内容走，不强行统一成一个宽度。
 */
export const pluginPageClass = "mx-auto w-full max-w-[960px] px-6 pb-12 pt-1";

/**
 * 以卡片网格或行列表为主体的页面（插件中心主页、教训库）。
 *
 * 三列卡片在 960 里每列只有 300 出头，描述被压成两行省略号；
 * 放到 1080 让每列多容几个字，右侧也不会留下一条空带。
 */
export const pluginCardPageClass =
  "mx-auto w-full max-w-[1080px] px-6 pb-12 pt-1";

/**
 * 以表格为主体的插件页（成绩单、请求日志）用的宽版心。
 *
 * 九列数字挤在 960 里会顶出横向滚动条，而窗口两侧还空着；
 * 放宽到 1080 让表格铺开，窄窗口仍由表格自身的横向滚动兜底。
 */
export const pluginWidePageClass =
  "mx-auto w-full max-w-[1080px] px-6 pb-12 pt-1";

/** 表单与长文本（设置、应用管理、隐私脱敏）的收窄版心。 */
export const formPageClass = "mx-auto w-full max-w-[760px] px-6 pb-12 pt-1";
