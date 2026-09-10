import { Input, Label } from "fju-project";

export const WithLabel = () => (
  <div className="w-72 space-y-1.5">
    <Label htmlFor="p-studentno">學號</Label>
    <Input id="p-studentno" defaultValue="411410123" className="h-11" />
  </div>
);

export const Search = () => (
  <div className="w-72">
    <Input placeholder="搜尋專題題目…" className="h-9" />
  </div>
);

export const Invalid = () => (
  <div className="w-72 space-y-1.5">
    <Label htmlFor="p-email">聯絡 Email</Label>
    <Input id="p-email" defaultValue="411410123@" aria-invalid className="h-11" />
    <p className="text-xs text-destructive">Email 格式不正確，請確認是否漏了網域。</p>
  </div>
);
