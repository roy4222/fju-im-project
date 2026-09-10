import { Button } from "fju-project";

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Button>送出繳交</Button>
    <Button variant="outline">儲存草稿</Button>
    <Button variant="secondary">預覽</Button>
    <Button variant="ghost">取消</Button>
    <Button variant="destructive">刪除項目</Button>
    <Button variant="link">查看歷史版本</Button>
  </div>
);

export const Sizes = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Button size="xs">xs</Button>
    <Button size="sm">開始評分</Button>
    <Button size="default">開始評分</Button>
    <Button size="lg">登入平台</Button>
  </div>
);

export const States = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Button>可送出</Button>
    <Button disabled>已截止</Button>
    <Button variant="outline" disabled>
      無權限
    </Button>
  </div>
);
