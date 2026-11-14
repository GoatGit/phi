/**
 * 插件中心与插件页共用的版心。
 *
 * 宽度按内容决定，不按「习惯」：卡片与列表要铺开，表单与长文本要收窄。
 * 窗口拉到最宽时，切换页签左右边缘也不跳。
 */
export const pluginPageClass = "mx-auto w-full max-w-[960px] px-6 pb-12 pt-1";

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
