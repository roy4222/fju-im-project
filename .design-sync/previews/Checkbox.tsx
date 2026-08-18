import { Checkbox, Label } from "fju-project";

/** 五人分組的逐一確認狀態 */
export const MemberConfirm = () => (
  <div className="w-72 space-y-3">
    {[
      { id: "m1", name: "林彥廷", no: "411410123", checked: true },
      { id: "m2", name: "黃詩涵", no: "411410145", checked: true },
      { id: "m3", name: "吳柏諺", no: "411410167", checked: true },
      { id: "m4", name: "蔡育瑄", no: "411410189", checked: false },
      { id: "m5", name: "鄭凱文", no: "411410201", checked: false },
    ].map((m) => (
      <div key={m.id} className="flex items-center gap-2.5">
        <Checkbox id={m.id} defaultChecked={m.checked} />
        <Label htmlFor={m.id} className="font-normal">
          {m.name}
        </Label>
        <span className="tabular text-xs text-muted-foreground">{m.no}</span>
      </div>
    ))}
  </div>
);

export const States = () => (
  <div className="flex items-center gap-6">
    <div className="flex items-center gap-2">
      <Checkbox id="s-off" />
      <Label htmlFor="s-off" className="font-normal">未選</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="s-on" defaultChecked />
      <Label htmlFor="s-on" className="font-normal">已選</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="s-ind" indeterminate />
      <Label htmlFor="s-ind" className="font-normal">部分選取</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="s-dis" disabled />
      <Label htmlFor="s-dis" className="font-normal">停用</Label>
    </div>
  </div>
);
