import { useTranslation } from "react-i18next";
import { PluginGuide } from "./PluginGlyph";

/**
 * 各插件页底部的说明块：作用 / 怎么用 / 注意事项。
 *
 * 文案集中在这一处，页面只负责把它放到内容之后、保存栏之上。
 * 写的时候按用户视角：替谁解决什么问题、按哪几步做、什么情况下不成立。
 */
export function ReportCardGuide() {
  const { t } = useTranslation();
  return (
    <PluginGuide
      pluginId="report-card"
      what={t("pluginCenter.lessonsGuide.reportCard.what")}
      steps={[
        t("pluginCenter.lessonsGuide.reportCard.step1"),
        t("pluginCenter.lessonsGuide.reportCard.step2"),
        t("pluginCenter.lessonsGuide.reportCard.step3"),
      ]}
      notes={t("pluginCenter.lessonsGuide.reportCard.notes")}
    />
  );
}

export function SessionBatonGuide() {
  const { t } = useTranslation();
  return (
    <PluginGuide
      pluginId="session-baton"
      what={t("pluginCenter.lessonsGuide.sessionBaton.what")}
      steps={[
        t("pluginCenter.lessonsGuide.sessionBaton.step1"),
        t("pluginCenter.lessonsGuide.sessionBaton.step2"),
        t("pluginCenter.lessonsGuide.sessionBaton.step3"),
      ]}
      notes={t("pluginCenter.lessonsGuide.sessionBaton.notes")}
    />
  );
}

export function PrivacyGuide() {
  const { t } = useTranslation();
  return (
    <PluginGuide
      pluginId="privacy"
      what={t("pluginCenter.lessonsGuide.privacy.what")}
      steps={[
        t("pluginCenter.lessonsGuide.privacy.step1"),
        t("pluginCenter.lessonsGuide.privacy.step2"),
        t("pluginCenter.lessonsGuide.privacy.step3"),
      ]}
      notes={t("pluginCenter.lessonsGuide.privacy.notes")}
    />
  );
}

export function McpRouterGuide() {
  const { t } = useTranslation();
  return (
    <PluginGuide
      pluginId="mcp-router"
      what={t("pluginCenter.lessonsGuide.mcpRouter.what")}
      steps={[
        t("pluginCenter.lessonsGuide.mcpRouter.step1"),
        t("pluginCenter.lessonsGuide.mcpRouter.step2"),
        t("pluginCenter.lessonsGuide.mcpRouter.step3"),
      ]}
      notes={t("pluginCenter.lessonsGuide.mcpRouter.notes")}
    />
  );
}

export function LessonsGuide() {
  const { t } = useTranslation();
  return (
    <PluginGuide
      pluginId="lessons"
      what={t("pluginCenter.lessonsGuide.lessons.what")}
      steps={[
        t("pluginCenter.lessonsGuide.lessons.step1"),
        t("pluginCenter.lessonsGuide.lessons.step2"),
        t("pluginCenter.lessonsGuide.lessons.step3"),
      ]}
      notes={t("pluginCenter.lessonsGuide.lessons.notes")}
    />
  );
}

export function TaskBoardGuide() {
  const { t } = useTranslation();
  return (
    <PluginGuide
      pluginId="task-board"
      what={t("pluginCenter.lessonsGuide.taskBoard.what")}
      steps={[
        t("pluginCenter.lessonsGuide.taskBoard.step1"),
        t("pluginCenter.lessonsGuide.taskBoard.step2"),
        t("pluginCenter.lessonsGuide.taskBoard.step3"),
      ]}
      notes={t("pluginCenter.lessonsGuide.taskBoard.notes")}
    />
  );
}
