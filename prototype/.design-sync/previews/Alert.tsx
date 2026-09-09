import { Alert, AlertDescription, AlertTitle } from "fju-project";

export const Notice = () => (
  <Alert className="w-96">
    <AlertTitle>尚未完成任何還原演練</AlertTitle>
    <AlertDescription>
      上線前必須在全新環境完成至少一次 restore drill，並記錄時間、版本與檔案抽查結果。
    </AlertDescription>
  </Alert>
);

export const Destructive = () => (
  <Alert variant="destructive" className="w-96">
    <AlertTitle>3 組逾期未繳</AlertTitle>
    <AlertDescription>
      系統驗收簡報與說明文件已於 8 月 15 日截止。逾期組別需由系辦個別重新開放並填具理由。
    </AlertDescription>
  </Alert>
);
