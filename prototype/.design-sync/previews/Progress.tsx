import { Progress, ProgressLabel, ProgressValue } from "fju-project";

/**
 * 收件項目完成率。
 *
 * 注意：<Progress> 的 Root 會在 children 之後自動渲染一組 Track + Indicator，
 * 不要再自己加 <ProgressTrack><ProgressIndicator/> —— 會變成上下兩條線。
 * children 只放 Label 與 Value。
 */
export const SubmissionRate = () => (
  <div className="w-80 space-y-5">
    {[
      { label: "指導老師意願調查表", value: 56 },
      { label: "專題分組名單確認表", value: 89 },
      { label: "專題題目與摘要初稿", value: 22 },
    ].map((r) => (
      // Root 是 flex-wrap：Label 與 Value 併成一行，自動渲染的 Track 佔滿寬度換行
      <Progress key={r.label} value={r.value} className="gap-1.5">
        <ProgressLabel className="text-sm font-medium">{r.label}</ProgressLabel>
        <ProgressValue className="tabular text-xs text-muted-foreground" />
      </Progress>
    ))}
  </div>
);
