import { Badge } from "fju-project";

/** 繳交生命週期的狀態標籤，對應 fixtures 的 SubmissionState */
export const SubmissionStates = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge variant="outline" className="border-border bg-muted text-muted-foreground">
      未開始
    </Badge>
    <Badge variant="outline" className="border-info/30 bg-info-subtle text-info-on-subtle">
      草稿
    </Badge>
    <Badge variant="outline" className="border-success/30 bg-success-subtle text-success-on-subtle">
      已繳交
    </Badge>
    <Badge variant="outline" className="border-warning/35 bg-warning-subtle text-warning-on-subtle">
      需重送
    </Badge>
    <Badge
      variant="outline"
      className="border-destructive/35 bg-destructive-subtle text-destructive-on-subtle"
    >
      已逾期
    </Badge>
  </div>
);

/** 品牌橘用於分類與強調，不用於 hover 底色 */
export const Categories = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge variant="outline" className="border-brand/30 bg-brand-subtle text-brand-on-subtle">
      產學合作
    </Badge>
    <Badge variant="outline" className="text-muted-foreground">
      一般專題
    </Badge>
    <Badge variant="outline" className="border-primary/25 bg-primary/8 text-primary">
      專題事務
    </Badge>
  </div>
);
